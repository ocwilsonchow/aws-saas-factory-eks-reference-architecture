/**
 * Tenant Onboarding Construct for SaaS EKS Architecture
 *
 * This construct creates and configures the tenant onboarding and deletion processes:
 * - CodeBuild projects for tenant provisioning and cleanup
 * - IAM permissions for tenant management operations
 * - Integration with EKS cluster for tenant-specific resources
 *
 * Key components:
 * - Tenant onboarding CodeBuild project
 * - Tenant deletion CodeBuild project
 * - IAM permissions for tenant lifecycle management
 * - CloudFront and Route53 integration for tenant-specific domains
 */
import * as cdk from 'aws-cdk-lib';
import { Arn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as aws_s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { SourceBucket } from './source-bucket';

/**
 * Properties for configuring the Tenant Onboarding construct
 */
export interface TenantOnboardingProps {
  /** Name for the tenant onboarding CodeBuild project */
  readonly onboardingProjectName: string;
  /** Name for the tenant deletion CodeBuild project */
  readonly deletionProjectName: string;
  /** Directory path containing the onboarding assets */
  readonly assetDirectory: string;

  /** Name of the EKS cluster where tenant resources will be deployed */
  readonly eksClusterName: string;
  /** IAM role with kubectl permissions for EKS operations */
  readonly codebuildKubectlRole: iam.IRole;
  /** ARN of the OIDC provider for the EKS cluster */
  readonly eksClusterOIDCProviderArn: string;

  /** Names of application service build projects for tenant deployment */
  readonly applicationServiceBuildProjectNames: string[];

  /** CloudFront distribution ID for the application site */
  readonly appSiteDistributionId: string;
  /** CloudFront domain for the application site */
  readonly appSiteCloudFrontDomain: string;
  /** Optional custom domain for the application site */
  readonly appSiteCustomDomain?: string;
  /** Optional hosted zone ID for DNS configuration */
  readonly appSiteHostedZoneId?: string;
}

/**
 * Construct that manages tenant onboarding and deletion processes
 */
export class TenantOnboarding extends Construct {
  /** URL of the repository containing tenant resources */
  readonly repositoryUrl: string;

  constructor(scope: Construct, id: string, props: TenantOnboardingProps) {
    super(scope, id);

    // Add necessary IAM permissions for tenant management
    this.addTenantOnboardingPermissions(props.codebuildKubectlRole, props);

    // Create source bucket for tenant onboarding assets
    const sourceBucket = new SourceBucket(this, `${id}SourceBucket`, {
      name: 'TenantOnboarding',
      assetDirectory: props.assetDirectory,
    });

    // Define CloudFormation parameters for tenant stack
    const onboardingCfnParams: { [key: string]: string } = {
      TenantId: '$TENANT_ID',
      CompanyName: '"$COMPANY_NAME"',
      TenantAdminEmail: '"$ADMIN_EMAIL"',
      AppDistributionId: `"${props.appSiteDistributionId}"`,
      DistributionDomain: `"${props.appSiteCloudFrontDomain}"`,
      EKSClusterName: `"${props.eksClusterName}"`,
      KubectlRoleArn: `"${props.codebuildKubectlRole.roleArn}"`,
      OIDCProviderArn: `"${props.eksClusterOIDCProviderArn}"`,
    };

    // Format parameters for CDK command
    const cfnParamString = Object.entries(onboardingCfnParams)
      .map((x) => `--parameters ${x[0]}=${x[1]}`)
      .join(' ');

    // Create tenant onboarding CodeBuild project
    const onboardingProject = new codebuild.Project(this, `TenantOnboardingProject`, {
      projectName: `${props.onboardingProjectName}`,
      source: sourceBucket.source,
      role: props.codebuildKubectlRole,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      },
      environmentVariables: {
        TENANT_ID: {
          value: '',
        },
        COMPANY_NAME: {
          value: '',
        },
        ADMIN_EMAIL: {
          value: '',
        },
        PLAN: {
          value: '',
        },
        AWS_ACCOUNT: {
          value: Stack.of(this).account,
        },
        AWS_REGION: {
          value: Stack.of(this).region,
        },
        APP_SITE_CUSTOM_DOMAIN: {
          value: props.appSiteCustomDomain ?? '',
        },
        APP_SITE_HOSTED_ZONE: {
          value: props.appSiteHostedZoneId ?? '',
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: ['npm i'],
          },
          pre_build: {
            commands: [],
          },
          build: {
            commands: [
              'npm run cdk bootstrap',
              `npm run cdk deploy TenantStack-$TENANT_ID -- --require-approval=never ${cfnParamString}`,
            ],
          },
          post_build: {
            commands: props.applicationServiceBuildProjectNames.map(
              (x) =>
                `aws codebuild start-build --project-name ${x}TenantDeploy --environment-variables-override name=TENANT_ID,value=\"$TENANT_ID\",type=PLAINTEXT`
            ),
          },
        },
      }),
    });

    // Create tenant deletion CodeBuild project
    const tenantDeletionProject = new codebuild.Project(this, 'TenantDeletionProject', {
      projectName: props.deletionProjectName,
      role: props.codebuildKubectlRole,
      source: sourceBucket.source,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      },
      environmentVariables: {
        TENANT_ID: {
          value: '',
        },
        AWS_ACCOUNT: {
          value: Stack.of(this).account,
        },
        AWS_REGION: {
          value: Stack.of(this).region,
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: ['npm i'],
          },
          pre_build: {
            commands: [],
          },
          build: {
            commands: [
              'npm run cdk bootstrap',
              `npm run cdk destroy TenantStack-$TENANT_ID -- --require-approval=never -f`,
            ],
          },
          post_build: {
            commands: [],
          },
        },
      }),
    });
  }

  /**
   * Adds necessary IAM permissions for tenant onboarding and deletion operations
   * @param projectRole The IAM role to which permissions will be added
   * @param props The tenant onboarding properties
   */
  private addTenantOnboardingPermissions(projectRole: iam.IRole, props: TenantOnboardingProps) {
    // TODO: reduce the permission

    projectRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['route53:*'],
        resources: [
          `arn:${Stack.of(this).partition}:route53:::hostedzone/${props.appSiteHostedZoneId!}`,
        ],
        effect: iam.Effect.ALLOW,
      })
    );
    projectRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'route53domains:*',
          'cognito-identity:*',
          'cognito-idp:*',
          'cognito-sync:*',
          'iam:*',
          's3:*',
          'cloudformation:*',
          'codebuild:StartBuild',
        ],
        resources: ['*'],
        effect: iam.Effect.ALLOW,
      })
    );
    projectRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudfront:AssociateAlias',
          'cloudfront:GetDistribution',
          'cloudfront:GetDistributionConfig',
          'cloudfront:UpdateDistribution',
        ],
        resources: [
          Arn.format(
            {
              service: 'cloudfront',
              resource: 'distribution',
              resourceName: props.appSiteDistributionId,
            },
            Stack.of(this)
          ),
        ],
        effect: iam.Effect.ALLOW,
      })
    );
    projectRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem'],
        resources: [
          Arn.format(
            { service: 'dynamodb', resource: 'table', resourceName: 'Tenant' },
            Stack.of(this)
          ),
        ],
        effect: iam.Effect.ALLOW,
      })
    );
    projectRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:CreateTable', 'dynamodb:DeleteTable'],
        resources: [
          Arn.format(
            { service: 'dynamodb', resource: 'table', resourceName: 'Order-*' },
            Stack.of(this)
          ),
        ],
        effect: iam.Effect.ALLOW,
      })
    );
    projectRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          Arn.format(
            { service: 'ssm', resource: 'parameter', resourceName: 'cdk-bootstrap/*' },
            Stack.of(this)
          ),
        ],
      })
    );
  }
}
