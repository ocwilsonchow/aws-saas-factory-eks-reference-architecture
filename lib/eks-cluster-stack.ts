/**
 * EKS Cluster Stack for SaaS EKS Architecture
 *
 * This stack creates and configures an Amazon EKS cluster with the necessary
 * networking, security groups, IAM roles, and add-ons for running a SaaS application.
 *
 * Key components:
 * - VPC with private subnets for EKS nodes
 * - Security groups with proper ingress/egress rules
 * - EKS cluster with managed node group
 * - NGINX ingress controller for routing traffic
 * - Service accounts with appropriate IAM permissions
 * - VPC CNI plugin for pod networking
 */
import { KubectlV29Layer } from '@aws-cdk/lambda-layer-kubectl-v29';
import { Arn, CfnJson, CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

import * as fs from 'fs';
import * as YAML from 'js-yaml';
import * as path from 'path';

/**
 * Properties for configuring the EKS Cluster Stack
 */
export interface EKSClusterStackProps extends StackProps {
  /** Name of the EKS cluster */
  readonly clusterName: string;
  /** Name of the CodeBuild project for tenant onboarding */
  readonly tenantOnboardingProjectName: string;
  /** Name of the CodeBuild project for tenant deletion */
  readonly tenantDeletionProjectName: string;
  /** Name of the NGINX ingress controller */
  readonly ingressControllerName: string;
  /** Name of the shared service account for cross-service operations */
  readonly sharedServiceAccountName: string;

  /** Optional token for Kubecost installation */
  readonly kubecostToken?: string;

  /** Optional custom domain for the application */
  readonly customDomain?: string;
  /** Optional hosted zone ID for DNS configuration */
  readonly hostedZoneId?: string;
}

/**
 * Stack that creates an EKS cluster with all necessary components for the SaaS application
 */
export class EKSClusterStack extends Stack {
  /** ARN of the IAM role used by CodeBuild for kubectl operations */
  readonly codebuildKubectlRoleArn: string;
  /** VPC where the EKS cluster is deployed */
  readonly vpc: ec2.Vpc;
  /** ARN of the OpenID Connect provider for the EKS cluster */
  readonly openIdConnectProviderArn: string;
  /** Domain name of the Network Load Balancer for the ingress controller */
  readonly nlbDomain: string;

  constructor(scope: Construct, id: string, props: EKSClusterStackProps) {
    super(scope, id, props);

    const useCustomDomain = props.customDomain ? true : false;

    if (useCustomDomain && !props.hostedZoneId) {
      throw new Error(`HostedZoneId must be specified when using custom domain.`);
    }

    // Create VPC for EKS cluster
    this.vpc = new ec2.Vpc(this, 'EKSVpc', {
      ipAddresses: ec2.IpAddresses.cidr('192.168.0.0/16'),
      maxAzs: 2,
      vpcName: 'EKS SaaS Vpc',
    });

    // Create security groups for control plane and nodes with proper rules
    const ctrlPlaneSecurityGroup = new ec2.SecurityGroup(this, 'ControlPlaneSecurityGroup', {
      vpc: this.vpc,
      allowAllOutbound: false,
      securityGroupName: 'eks-saas-ctrl-plane-security-group',
      description: 'EKS SaaS control plane security group with recommended traffic rules',
    });
    const nodeSecurityGroup = new ec2.SecurityGroup(this, 'NodeSecurityGroup', {
      vpc: this.vpc,
      allowAllOutbound: true,
      securityGroupName: 'eks-saas-mng-node-security-group',
      description:
        'EKS SaaS node group security group with recommended traffic rules + NLB target group health check access',
    });

    // Configure security group rules for control plane to node communication
    ctrlPlaneSecurityGroup.addIngressRule(nodeSecurityGroup, ec2.Port.tcp(443));
    ctrlPlaneSecurityGroup.addEgressRule(nodeSecurityGroup, ec2.Port.tcp(443)); // needed for nginx-ingress admission controller
    ctrlPlaneSecurityGroup.addEgressRule(nodeSecurityGroup, ec2.Port.tcpRange(1025, 65535));

    // Configure security group rules for node-to-node and control plane to node communication
    nodeSecurityGroup.addIngressRule(nodeSecurityGroup, ec2.Port.allTraffic());
    nodeSecurityGroup.addIngressRule(ctrlPlaneSecurityGroup, ec2.Port.tcp(443));
    nodeSecurityGroup.addIngressRule(ctrlPlaneSecurityGroup, ec2.Port.tcpRange(1025, 65535));

    // Allow NLB health checks
    nodeSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcpRange(1025, 65535),
      'Needed for the NLB target group health checks'
    );

    // Create admin role for cluster management
    const clusterAdmin = new iam.Role(this, 'AdminRole', {
      assumedBy: new iam.AccountRootPrincipal(),
    });

    // Create the EKS cluster
    const cluster = new eks.Cluster(this, 'SaaSCluster', {
      clusterName: props.clusterName,
      defaultCapacity: 0,
      kubectlLayer: new KubectlV29Layer(this, 'kubectl'),
      mastersRole: clusterAdmin,
      securityGroup: ctrlPlaneSecurityGroup,
      version: eks.KubernetesVersion.V1_29,
      vpc: this.vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
    });

    // Create service account role for VPC CNI plugin
    const vpcCniSvcAccountRole = new iam.Role(this, 'VpcCniSvcAccountRole', {
      assumedBy: new iam.OpenIdConnectPrincipal(cluster.openIdConnectProvider).withConditions({
        StringEquals: new CfnJson(this, 'VpcCniSvcAccountRoleCondition', {
          value: {
            [`${cluster.openIdConnectProvider.openIdConnectProviderIssuer}:aud`]:
              'sts.amazonaws.com',
            [`${cluster.openIdConnectProvider.openIdConnectProviderIssuer}:sub`]:
              'system:serviceaccount:kube-system:aws-node',
          },
        }),
      }),
    });
    vpcCniSvcAccountRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy')
    );

    // Install VPC CNI plugin as an EKS add-on
    const vpcCniPlugin = new eks.CfnAddon(this, 'VpcCniPlugin', {
      addonName: 'vpc-cni',
      clusterName: props.clusterName,
      resolveConflicts: 'OVERWRITE',
      serviceAccountRoleArn: vpcCniSvcAccountRole.roleArn,
    });

    // Create IAM role for worker nodes
    const nodeRole = new iam.Role(this, 'EKSNodeRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    this.addNodeIAMRolePolicies(nodeRole);

    // Create launch template for node group
    const nodeLaunchTemplate = new ec2.LaunchTemplate(this, 'saas-mng-lt', {
      securityGroup: nodeSecurityGroup,
    });

    // Add managed node group to the cluster
    const nodegroup = cluster.addNodegroupCapacity('saas-mng', {
      nodegroupName: 'saas-managed-nodegroup',
      amiType: eks.NodegroupAmiType.AL2_X86_64,
      capacityType: eks.CapacityType.ON_DEMAND,
      nodeRole: nodeRole,
      minSize: 1,
      desiredSize: 2,
      maxSize: 4,
      instanceTypes: [new ec2.InstanceType('m5.large')],
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      launchTemplateSpec: {
        id: nodeLaunchTemplate.launchTemplateId!,
      },
    });
    nodegroup.node.addDependency(vpcCniPlugin);

    // Create IAM role for CodeBuild to interact with the cluster
    const codebuildKubectlRole = new iam.Role(this, 'CodebuildKubectlRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('codebuild.amazonaws.com'),
        new iam.AccountRootPrincipal()
      ),
    });
    codebuildKubectlRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['eks:DescribeCluster'],
        resources: [cluster.clusterArn],
        effect: iam.Effect.ALLOW,
      })
    );

    codebuildKubectlRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr-public:GetAuthorizationToken'],
        resources: ['*'],
        effect: iam.Effect.ALLOW,
      })
    );

    codebuildKubectlRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:GetServiceBearerToken'],
        resources: ['*'],
        effect: iam.Effect.ALLOW,
      })
    );
    cluster.awsAuth.addMastersRole(codebuildKubectlRole);

    this.codebuildKubectlRoleArn = codebuildKubectlRole.roleArn;
    this.openIdConnectProviderArn = cluster.openIdConnectProvider.openIdConnectProviderArn;

    // Add permissions for shared services
    this.addSharedServicesPermissions(cluster, props);

    // // add nginx-ingress
    // const nginxValues = fs.readFileSync(
    //   path.join(__dirname, '..', 'resources', 'nginx-ingress-config.yaml'),
    //   'utf8'
    // );
    // const nginxValuesAsRecord = YAML.load(nginxValues) as Record<string, any>;

    // Install NGINX ingress controller using Helm
    const nginxChart = cluster.addHelmChart('IngressController', {
      chart: 'nginx-ingress',
      repository: 'https://helm.nginx.com/stable',
      release: props.ingressControllerName,
      values: {
        controller: {
          publishService: {
            enabled: true,
          },
          service: {
            annotations: {
              'service.beta.kubernetes.io/aws-load-balancer-type': 'nlb',
              'service.beta.kubernetes.io/aws-load-balancer-backend-protocol': 'http',
              'service.beta.kubernetes.io/aws-load-balancer-ssl-ports': '443',
              'service.beta.kubernetes.io/aws-load-balancer-connection-idle-timeout': '3600',
            },
            targetPorts: {
              https: 'http',
            },
          },
        },
      },
    });

    nginxChart.node.addDependency(nodegroup);

    // Get the NLB domain for the ingress controller
    this.nlbDomain = cluster.getServiceLoadBalancerAddress(
      `${props.ingressControllerName}-nginx-ingress-controller`
    );

    // Create primary mergeable ingress for host collision handling
    new eks.KubernetesManifest(this, 'PrimarySameHostMergableIngress', {
      cluster: cluster,
      overwrite: true,
      manifest: [
        {
          apiVersion: 'networking.k8s.io/v1',
          kind: 'Ingress',
          metadata: {
            name: 'default-primary-mergable-ingress',
            namespace: 'default',
            annotations: {
              'kubernetes.io/ingress.class': 'nginx',
              'nginx.org/mergeable-ingress-type': 'master',
            },
          },
          spec: {
            rules: [
              {
                host: this.nlbDomain,
              },
            ],
          },
        },
      ],
    });

    /* if (props.kubecostToken) {
            this.installKubecost(cluster, nodegroup, props.kubecostToken!, this.nlbDomain);
        } */
  }

  /**
   * Adds required IAM policies to the EKS node role
   * @param eksNodeRole The IAM role for EKS worker nodes
   */
  private addNodeIAMRolePolicies(eksNodeRole: iam.Role): void {
    eksNodeRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy')
    );
    eksNodeRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly')
    );
    eksNodeRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );
  }

  /**
   * Creates a service account with permissions for shared services
   * @param cluster The EKS cluster
   * @param props The stack properties
   */
  private addSharedServicesPermissions(cluster: eks.Cluster, props: EKSClusterStackProps) {
    const sharedServiceAccount = cluster.addServiceAccount('SaaSServiceAccount', {
      name: props.sharedServiceAccountName,
      namespace: 'default',
    });

    // Add permissions for DynamoDB operations
    sharedServiceAccount.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:BatchGetItem',
          'dynamodb:Query',
          'dynamodb:Scan',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:BatchWriteItem',
        ],
        resources: [
          Arn.format({ service: 'dynamodb', resource: 'table', resourceName: 'Tenant' }, this),
        ],
        effect: iam.Effect.ALLOW,
      })
    );

    // Add permissions for CodeBuild operations
    sharedServiceAccount.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['codebuild:StartBuild'],
        resources: [
          Arn.format(
            {
              service: 'codebuild',
              resource: 'project',
              resourceName: props.tenantOnboardingProjectName,
            },
            this
          ),
          Arn.format(
            {
              service: 'codebuild',
              resource: 'project',
              resourceName: props.tenantDeletionProjectName,
            },
            this
          ),
        ],
        effect: iam.Effect.ALLOW,
      })
    );

    // Add permissions for Cognito operations
    sharedServiceAccount.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:ListUsers'],
        resources: [
          Arn.format({ service: 'cognito-idp', resource: 'userpool', resourceName: '*' }, this),
        ],
        effect: iam.Effect.ALLOW,
      })
    );
  }
}
