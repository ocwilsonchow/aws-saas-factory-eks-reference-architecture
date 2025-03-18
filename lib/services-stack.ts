/**
 * Services Stack for SaaS EKS Architecture
 *
 * This stack creates and configures the application services that run on the EKS cluster,
 * including product and order microservices, as well as the tenant onboarding process.
 *
 * Key components:
 * - Application services (Product Service, Order Service)
 * - Tenant onboarding and deletion functionality
 * - Integration with EKS cluster via OIDC provider
 * - Configuration for custom domains and CloudFront distribution
 */
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { ApplicationService } from './constructs/application-service';
import { TenantOnboarding } from './constructs/tenant-onboarding';

/**
 * Properties for configuring the Services Stack
 */
export interface ServicesStackProps extends StackProps {
  /** ARN of the OpenID Connect provider for the EKS cluster */
  readonly eksClusterOIDCProviderArn: string;
  /** Domain name of the Network Load Balancer for internal API access */
  readonly internalNLBApiDomain: string;
  /** Name of the EKS cluster */
  readonly eksClusterName: string;
  /** ARN of the IAM role used by CodeBuild for kubectl operations */
  readonly codebuildKubectlRoleArn: string;
  /** ID of the CloudFront distribution for the application site */
  readonly appSiteDistributionId: string;
  /** Domain name of the CloudFront distribution for the application site */
  readonly appSiteCloudFrontDomain: string;
  /** Name of the shared service account for cross-service operations */
  readonly sharedServiceAccountName: string;
  /** Optional hosted zone ID for DNS configuration */
  readonly appHostedZoneId?: string;
  /** Optional custom domain for the application */
  readonly customDomain?: string;
}

/**
 * Stack that creates application services and tenant onboarding functionality
 */
export class ServicesStack extends Stack {
  constructor(scope: Construct, id: string, props: ServicesStackProps) {
    super(scope, id, props);

    const role = iam.Role.fromRoleArn(this, 'CodebuildKubectlRole', props.codebuildKubectlRoleArn);

    // application services
    new ApplicationService(this, 'ProductService', {
      internalApiDomain: props.internalNLBApiDomain,
      eksClusterName: props.eksClusterName,
      codebuildKubectlRole: role,
      name: 'ProductService',
      ecrImageName: 'product-svc',
      serviceUrlPrefix: 'products',
      assetDirectory: path.join(
        __dirname,
        '..',
        'services',
        'application-services',
        'product-service'
      ),
    });

    new ApplicationService(this, 'OrderService', {
      internalApiDomain: props.internalNLBApiDomain,
      eksClusterName: props.eksClusterName,
      codebuildKubectlRole: role,
      name: 'OrderService',
      ecrImageName: 'order-svc',
      serviceUrlPrefix: 'orders',
      assetDirectory: path.join(
        __dirname,
        '..',
        'services',
        'application-services',
        'order-service'
      ),
    });

    new TenantOnboarding(this, 'TenantOnboarding', {
      appSiteCloudFrontDomain: props.appSiteCloudFrontDomain,
      appSiteDistributionId: props.appSiteDistributionId,
      codebuildKubectlRole: role,
      eksClusterOIDCProviderArn: props.eksClusterOIDCProviderArn,
      eksClusterName: props.eksClusterName,
      applicationServiceBuildProjectNames: ['ProductService', 'OrderService'],
      onboardingProjectName: 'TenantOnboardingProject',
      deletionProjectName: 'TenantDeletionProject',
      appSiteHostedZoneId: props.appHostedZoneId,
      appSiteCustomDomain: props.customDomain ? `app.${props.customDomain!}` : undefined,
      assetDirectory: path.join(__dirname, '..', 'services', 'tenant-onboarding'),
    });
  }
}
