/**
 * Static Sites Stack for SaaS EKS Architecture
 *
 * This stack creates and configures the static websites for the SaaS application:
 * - Admin site: For system administrators to manage the platform
 * - Application site: For tenants to access their applications
 *
 * Key components:
 * - CloudFront distributions for content delivery
 * - S3 buckets for static content hosting
 * - Route53 configuration for custom domains
 * - Site configuration with environment-specific settings
 */
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import * as path from 'path';
import { StaticSite } from './constructs/static-site';
import { SourceBucket } from './constructs/source-bucket';

/**
 * Properties for configuring the Static Sites Stack
 */
export interface StaticSitesStackProps extends StackProps {
  /** URL for the application API */
  readonly apiUrl: string;
  /** URL for the control plane API */
  readonly controlPlaneUrl: string;

  /** Flag indicating whether KubeCost is enabled */
  readonly usingKubeCost: boolean;
  /** Optional client ID for authentication */
  readonly clientId?: string;
  /** Optional authorization server URL */
  readonly authorizationServer?: string;
  /** Optional well-known endpoint URL for OIDC discovery */
  readonly wellKnownEndpointUrl?: string;
  /** Optional custom base domain for the sites */
  readonly customBaseDomain?: string;
  /** Optional hosted zone ID for DNS configuration */
  readonly hostedZoneId?: string;
}

/**
 * Stack that creates and configures the static websites for the SaaS application
 */
export class StaticSitesStack extends Stack {
  /** CloudFront distribution for the application site */
  readonly applicationSiteDistribution: Distribution;

  constructor(scope: Construct, id: string, props: StaticSitesStackProps) {
    super(scope, id, props);

    // Determine if custom domain is being used
    const useCustomDomain = props.customBaseDomain ? true : false;
    if (useCustomDomain && !props.hostedZoneId) {
      throw new Error(
        'HostedZoneId must be specified when using a custom domain for static sites.'
      );
    }

    // Get hosted zone if using custom domain
    const hostedZone = useCustomDomain
      ? route53.PublicHostedZone.fromHostedZoneAttributes(this, 'PublicHostedZone', {
          hostedZoneId: props.hostedZoneId!,
          zoneName: props.customBaseDomain!,
        })
      : undefined;

    // Create source bucket for static site assets
    const sourceBucket = new SourceBucket(this, 'static-sites-source', {
      name: 'static-sites-source',
      assetDirectory: path.join(path.dirname(__filename), '..', 'clients'),
      excludes: ['node_modules', '.vscode', 'dist', '.angular'],
    });

    // Admin site
    const adminSite = new StaticSite(this, 'AdminSite', {
      name: 'AdminSite',
      sourceBucket,
      project: 'Admin',
      assetDirectory: path.join(path.dirname(__filename), '..', 'clients'),
      allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
      siteConfigurationGenerator: (siteDomain) => ({
        apiUrl: props.controlPlaneUrl,
        authServer: props.authorizationServer!,
        clientId: props.clientId!,
        domain: siteDomain,
        kubecostUI: props.usingKubeCost ? `${props.apiUrl}/kubecost` : '',
        production: true,
        usingCustomDomain: useCustomDomain,
        usingKubeCost: props.usingKubeCost,
        wellKnownEndpointUrl: props.wellKnownEndpointUrl!,
      }),
      customDomain: useCustomDomain ? `admin.${props.customBaseDomain!}` : undefined,
      hostedZone: hostedZone,
    });
    new CfnOutput(this, `AdminSiteUrl`, {
      value: `https://${adminSite.siteDomain}`,
    });

    // Application site
    const applicationSite = new StaticSite(this, 'ApplicationSite', {
      name: 'ApplicationSite',
      sourceBucket,
      project: 'Application',
      assetDirectory: path.join(path.dirname(__filename), '..', 'clients'),
      allowedMethods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
      siteConfigurationGenerator: (siteDomain) => ({
        production: true,
        apiUrl: props.apiUrl,
        controlPlaneUrl: props.controlPlaneUrl,
        domain: siteDomain,
        usingCustomDomain: useCustomDomain,
      }),
      customDomain: useCustomDomain ? `app.${props.customBaseDomain!}` : undefined,
      certDomain: useCustomDomain ? `*.app.${props.customBaseDomain!}` : undefined,
      hostedZone: hostedZone,
    });

    this.applicationSiteDistribution = applicationSite.cloudfrontDistribution;
    new CfnOutput(this, 'ApplicationSiteUrl', {
      value: `https://${applicationSite.siteDomain}`,
    });
  }
}
