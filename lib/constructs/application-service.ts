import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { SourceBucket } from './source-bucket';

/**
 * Properties for creating an ApplicationService
 */
export interface ApplicationServiceProps {
  /** Name of the application service */
  readonly name: string;
  /** Directory containing the service source code */
  readonly assetDirectory: string;
  /** Name for the ECR image */
  readonly ecrImageName: string;
  /** Name of the EKS cluster where the service will be deployed */
  readonly eksClusterName: string;
  /** IAM role with kubectl permissions for CodeBuild */
  readonly codebuildKubectlRole: iam.IRole;
  /** Internal API domain for service routing */
  readonly internalApiDomain: string;
  /** URL prefix for the service endpoints */
  readonly serviceUrlPrefix: string;
}

/**
 * Construct that represents a containerized application service
 * deployed to EKS with multi-tenant support
 */
export class ApplicationService extends Construct {
  /** URL of the code repository */
  readonly codeRepositoryUrl: string;

  constructor(scope: Construct, id: string, props: ApplicationServiceProps) {
    super(scope, id);

    // Create ECR repository to store container images
    const containerRepo = new ecr.Repository(this, `${id}ECR`, {
      repositoryName: props.ecrImageName,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Custom resource to force ECR repository deletion (even with images)
    new cr.AwsCustomResource(this, 'ECRRepoDeletion', {
      onDelete: {
        service: 'ECR',
        action: 'deleteRepository',
        parameters: {
          repositoryName: containerRepo.repositoryName,
          force: true,
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [containerRepo.repositoryArn] }),
    });

    // Create S3 bucket to store service source code
    const sourceBucket = new SourceBucket(this, `${props.name}SourceBucket`, {
      assetDirectory: props.assetDirectory,
      name: props.name,
    });

    // Create CodeBuild project to build and deploy the service to EKS
    const project = new codebuild.Project(this, `${id}EKSDeployProject`, {
      projectName: `${props.name}`,
      source: sourceBucket.source,
      role: props.codebuildKubectlRole,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true, // Required for Docker commands
      },
      environmentVariables: {
        CLUSTER_NAME: {
          value: `${props.eksClusterName}`,
        },
        ECR_REPO_URI: {
          value: `${containerRepo.repositoryUri}`,
        },
        AWS_REGION: {
          value: Stack.of(this).region,
        },
        AWS_ACCOUNT: {
          value: Stack.of(this).account,
        },
        SERVICE_IMAGE_NAME: {
          value: props.ecrImageName,
        },
        SERVICE_URL_PREFIX: {
          value: props.serviceUrlPrefix,
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              // Convert API host to lowercase and set as environment variable
              `export API_HOST=$(echo '${
                props.internalApiDomain || ''
              }' | awk '{print tolower($0)}')`,
              // Download kubectl binary
              'curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"',
              // Make kubectl executable
              'chmod +x ./kubectl',
            ],
          },
          pre_build: {
            commands: [
              // Authenticate with ECR to push/pull images
              'aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REPO_URI',
              // Authenticate with public ECR for base images
              'aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws',
            ],
          },
          build: {
            commands: [
              // Build Docker image
              'docker build -t $SERVICE_IMAGE_NAME:v1 .',
              // Tag image for ECR
              'docker tag $SERVICE_IMAGE_NAME:v1 $ECR_REPO_URI:latest',
              'docker tag $SERVICE_IMAGE_NAME:v1 $ECR_REPO_URI:v1',
              // Push images to ECR
              'docker push $ECR_REPO_URI:latest',
              'docker push $ECR_REPO_URI:v1',
            ],
          },
          post_build: {
            commands: [
              // Configure kubectl to use the EKS cluster
              'aws eks --region $AWS_REGION update-kubeconfig --name $CLUSTER_NAME',
              // Update kustomization.yaml with ECR image details
              'echo "  newName: $ECR_REPO_URI" >> kubernetes/kustomization.yaml',
              'echo "  newTag: v1" >> kubernetes/kustomization.yaml',
              // Set API host in host-patch.yaml
              'echo "  value: $API_HOST" >> kubernetes/host-patch.yaml',
              // Deploy to all tenant namespaces
              'for res in `kubectl get ns -l saas/tenant=true -o jsonpath=\'{.items[*].metadata.name}\'`; do \
                            cp kubernetes/svc-acc-patch-template.yaml kubernetes/svc-acc-patch.yaml && \
                            cp kubernetes/path-patch-template.yaml kubernetes/path-patch.yaml && \
                            echo "  value: $res-service-account" >> kubernetes/svc-acc-patch.yaml && \
                            echo "  value: /$res/$SERVICE_URL_PREFIX" >> kubernetes/path-patch.yaml && \
                            kubectl apply -k kubernetes/ -n $res && \
                            rm kubernetes/path-patch.yaml && rm kubernetes/svc-acc-patch.yaml; done',
            ],
          },
        },
      }),
    });

    // Grant permissions to push/pull from ECR
    containerRepo.grantPullPush(project.role!);

    // Custom resource to trigger initial build when the repo is created
    const buildTriggerResource = new cr.AwsCustomResource(this, 'ApplicationSvcIntialBuild', {
      onCreate: {
        service: 'CodeBuild',
        action: 'startBuild',
        parameters: {
          projectName: project.projectName,
        },
        physicalResourceId: cr.PhysicalResourceId.of(`InitialAppSvcDeploy-${props.name}`),
        outputPaths: ['build.id', 'build.buildNumber'],
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [project.projectArn] }),
    });
    buildTriggerResource.node.addDependency(project);

    // Create CodeBuild project for deploying to a specific tenant namespace
    const tenantDeployProject = new codebuild.Project(this, `${id}EKSTenantDeployProject`, {
      projectName: `${props.name}TenantDeploy`,
      role: props.codebuildKubectlRole,
      source: sourceBucket.source,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      },
      environmentVariables: {
        CLUSTER_NAME: {
          value: `${props.eksClusterName}`,
        },
        ECR_REPO_URI: {
          value: `${containerRepo.repositoryUri}`,
        },
        AWS_REGION: {
          value: Stack.of(this).region,
        },
        AWS_ACCOUNT: {
          value: Stack.of(this).account,
        },
        SERVICE_IMAGE_NAME: {
          value: props.ecrImageName,
        },
        SERVICE_URL_PREFIX: {
          value: props.serviceUrlPrefix,
        },
        TENANT_ID: {
          value: '', // Will be set at runtime when deploying to a specific tenant
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              // Convert API host to lowercase and set as environment variable
              `export API_HOST=$(echo '${
                props.internalApiDomain || ''
              }' | awk '{print tolower($0)}')`,
              // Download kubectl binary
              'curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"',
              // Make kubectl executable
              'chmod +x ./kubectl',
            ],
          },
          pre_build: {
            commands: [],
          },
          build: {
            commands: [
              // Configure kubectl to use the EKS cluster
              'aws eks --region $AWS_REGION update-kubeconfig --name $CLUSTER_NAME',
              // Update kustomization.yaml with ECR image details
              'echo "  newName: $ECR_REPO_URI" >> kubernetes/kustomization.yaml',
              'echo "  newTag: latest" >> kubernetes/kustomization.yaml',
              // Set API host in host-patch.yaml
              'echo "  value: $API_HOST" >> kubernetes/host-patch.yaml',
              // Create path-patch.yaml for tenant-specific URL path
              'cp kubernetes/path-patch-template.yaml kubernetes/path-patch.yaml',
              'echo "  value: /$TENANT_ID/$SERVICE_URL_PREFIX" >> kubernetes/path-patch.yaml',
              // Create svc-acc-patch.yaml for tenant-specific service account
              'cp kubernetes/svc-acc-patch-template.yaml kubernetes/svc-acc-patch.yaml',
              `echo "  value: $TENANT_ID-service-account" >> kubernetes/svc-acc-patch.yaml`,
              // Apply Kubernetes resources to tenant namespace
              'kubectl apply -k kubernetes/ -n $TENANT_ID',
            ],
          },
          post_build: {
            commands: [],
          },
        },
      }),
    });

    // Grant permission to pull images from ECR (no push needed for tenant deployment)
    containerRepo.grantPull(tenantDeployProject.role!);
  }
}
