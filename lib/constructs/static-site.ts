/**
 * Static Site Construct for SaaS EKS Architecture
 *
 * This construct creates and configures a static website with CloudFront distribution:
 * - S3 bucket for hosting static content
 * - CloudFront distribution for content delivery
 * - Optional custom domain with Route53 configuration
 * - CI/CD pipeline for automated deployments
 *
 * Key components:
 * - CloudFront distribution with S3 origin
 * - CodePipeline for automated builds and deployments
 * - Custom domain and certificate management (optional)
 * - Environment-specific configuration injection
 */
import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as alias from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { SourceBucket } from './source-bucket';

/**
 * Properties for configuring the Static Site
 */
export interface StaticSiteProps {
  /** Name identifier for the static site */
  readonly name: string;
  /** Source bucket containing the site assets */
  readonly sourceBucket: SourceBucket;
  /** Project name for the static site (used in build configuration) */
  readonly project: string;
  /** Directory path containing the site assets */
  readonly assetDirectory: string;
  /** HTTP methods allowed by the CloudFront distribution */
  readonly allowedMethods: string[];
  /** Function to generate site-specific configuration based on domain */
  readonly siteConfigurationGenerator: (
    siteDomain: string
  ) => Record<string, string | number | boolean>;

  /** Optional custom domain for the site */
  readonly customDomain?: string;
  /** Optional certificate domain (defaults to customDomain if not specified) */
  readonly certDomain?: string;
  /** Optional hosted zone for DNS configuration */
  readonly hostedZone?: route53.IHostedZone;
  /** Optional Cognito configuration for user authentication */
  readonly cognitoProps?: {
    /** Email address for the admin user */
    adminUserEmail: string;
    /** Function to generate email subject for user creation */
    emailSubjectGenerator?: (siteName: string) => string;
    /** Function to generate email body for user creation */
    emailBodyGenerator?: (siteDomain: string) => string;
  };
}

/**
 * Default email subject generator for user creation notifications
 */
const defaultEmailSubjectGenerator = (siteName: string) => `${siteName} User Created`;

/**
 * Default email body generator for user creation notifications
 */
const defaultEmailBodyGenerator = (siteDomain: string) =>
  `Your username is {username} and temporary password is {####}. Please login here: https://${siteDomain}`;

/**
 * Construct that creates a static website with CloudFront distribution and CI/CD pipeline
 */
export class StaticSite extends Construct {
  /** URL of the source code repository */
  readonly repositoryUrl: string;
  /** Domain name for the static site */
  readonly siteDomain: string;
  /** CloudFront distribution for content delivery */
  readonly cloudfrontDistribution: cloudfront.Distribution;
  /** S3 bucket hosting the static site content */
  readonly siteBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StaticSiteProps) {
    super(scope, id);

    const useCustomDomain = props.customDomain ? true : false;

    if (useCustomDomain && !props.hostedZone) {
      throw new Error(`HostedZone cannot be empty for the custom domain '${props.customDomain}'`);
    }

    const { distribution, appBucket } = this.createStaticSite(
      id,
      props.allowedMethods,
      useCustomDomain,
      props.customDomain,
      props.certDomain,
      props.hostedZone
    );
    this.cloudfrontDistribution = distribution;
    this.siteBucket = appBucket;
    this.siteDomain = useCustomDomain ? props.customDomain! : distribution.domainName;

    const siteConfig = props.siteConfigurationGenerator(this.siteDomain);

    this.createCICDForStaticSite(
      id,
      props.project,
      distribution.distributionId,
      siteConfig,
      appBucket,
      props.sourceBucket
    );
  }

  /**
   * Creates the static site infrastructure including S3 bucket and CloudFront distribution
   * @param id Construct ID
   * @param allowedMethods HTTP methods allowed by CloudFront
   * @param useCustomDomain Whether to use a custom domain
   * @param customDomain Custom domain name (if applicable)
   * @param certDomain Certificate domain name (if applicable)
   * @param hostedZone Hosted zone for DNS configuration (if applicable)
   * @returns The CloudFront distribution and S3 bucket
   */
  private createStaticSite(
    id: string,
    allowedMethods: string[],
    useCustomDomain: boolean,
    customDomain?: string,
    certDomain?: string,
    hostedZone?: route53.IHostedZone
  ) {
    const oai = new cloudfront.OriginAccessIdentity(this, `${id}OriginAccessIdentity`, {
      comment: 'Special CloudFront user to fetch S3 contents',
    });

    let siteCertificate = undefined;
    let domainNamesToUse = undefined;

    if (useCustomDomain) {
      siteCertificate = new acm.DnsValidatedCertificate(this, `${id}Certificate`, {
        domainName: certDomain ?? customDomain!,
        hostedZone: hostedZone!,
        region: 'us-east-1',
      });

      domainNamesToUse = new Array<string>(certDomain ?? customDomain!);
    }

    const appBucket = new s3.Bucket(this, `${id}Bucket`, {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
    });

    appBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        resources: [appBucket.arnForObjects('*')],
        actions: ['s3:GetObject'],
        principals: [
          new iam.CanonicalUserPrincipal(oai.cloudFrontOriginAccessIdentityS3CanonicalUserId),
        ],
      })
    );

    const distribution = new cloudfront.Distribution(this, `${id}Distribution`, {
      defaultBehavior: {
        origin: new origins.S3Origin(appBucket, {
          originAccessIdentity: oai,
        }),
        allowedMethods: { methods: allowedMethods },
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,

        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      certificate: siteCertificate,
      defaultRootObject: 'index.html',
      domainNames: domainNamesToUse,
      enabled: true,
      errorResponses: [
        // Needed to support angular routing
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      httpVersion: cloudfront.HttpVersion.HTTP2,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2018,
    });

    if (useCustomDomain) {
      new route53.ARecord(this, `${id}AliasRecord`, {
        zone: hostedZone!,
        recordName: certDomain ?? customDomain!,
        target: route53.RecordTarget.fromAlias(new alias.CloudFrontTarget(distribution)),
      });
    }

    return { distribution, appBucket };
  }

  /**
   * Creates the CI/CD pipeline for building and deploying the static site
   * @param id Construct ID
   * @param project Project name for the build configuration
   * @param cloudfrontDistributionId CloudFront distribution ID for cache invalidation
   * @param siteConfig Site-specific configuration to inject during build
   * @param distroBucket S3 bucket for the CloudFront distribution
   * @param sourceBucket Source bucket containing the site assets
   */
  private createCICDForStaticSite(
    id: string,
    project: string,
    cloudfrontDistributionId: string,
    siteConfig: Record<string, string | number | boolean>,
    distroBucket: s3.Bucket,
    sourceBucket: SourceBucket
  ) {
    const pipeline = new codepipeline.Pipeline(this, `${id}CodePipeline`, {
      pipelineType: codepipeline.PipelineType.V2,
      crossAccountKeys: false,
      artifactBucket: new s3.Bucket(this, `${id}CodePipelineBucket`, {
        autoDeleteObjects: true,
        removalPolicy: RemovalPolicy.DESTROY,
        enforceSSL: true,
      }),
    });
    const sourceArtifact = new codepipeline.Artifact();

    pipeline.addStage({
      stageName: 'Source',
      actions: [
        new actions.S3SourceAction({
          actionName: 'Checkout',
          output: sourceArtifact,
          bucket: sourceBucket.bucket,
          bucketKey: sourceBucket.key,
        }),
      ],
    });

    const buildProject = new codebuild.PipelineProject(this, `${id}AngularBuildProject`, {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: ['npm install'],
          },
          build: {
            commands: [
              `echo 'export const environment = ${JSON.stringify(
                siteConfig
              )}' > ./projects/${project.toLowerCase()}/src/environments/environment.development.ts`,
              `echo 'export const environment = ${JSON.stringify(
                siteConfig
              )}' > ./projects/${project.toLowerCase()}/src/environments/environment.ts`,
              `npm run build ${project}`,
            ],
          },
        },
        artifacts: {
          files: ['**/*'],
          'base-directory': `dist/${project.toLowerCase()}/browser`,
        },
      }),

      environmentVariables: {},
    });

    const buildOutput = new codepipeline.Artifact();

    pipeline.addStage({
      stageName: 'Build',
      actions: [
        new actions.CodeBuildAction({
          actionName: 'CompileNgSite',
          input: sourceArtifact,
          project: buildProject,
          outputs: [buildOutput],
        }),
      ],
    });

    const invalidateBuildProject = new codebuild.PipelineProject(this, `${id}InvalidateProject`, {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              'aws cloudfront create-invalidation --distribution-id ${CLOUDFRONT_ID} --paths "/*"',
            ],
          },
        },
      }),
      environmentVariables: {
        CLOUDFRONT_ID: { value: cloudfrontDistributionId },
      },
    });

    const distributionArn = `arn:aws:cloudfront::${
      Stack.of(this).account
    }:distribution/${cloudfrontDistributionId}`;
    invalidateBuildProject.addToRolePolicy(
      new iam.PolicyStatement({
        resources: [distributionArn],
        actions: ['cloudfront:CreateInvalidation'],
      })
    );

    pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        new actions.S3DeployAction({
          actionName: 'CopyToS3',
          bucket: distroBucket,
          input: buildOutput,
          cacheControl: [actions.CacheControl.fromString('no-store')],
          runOrder: 1,
        }),
        new actions.CodeBuildAction({
          actionName: 'InvalidateCloudFront',
          input: buildOutput,
          project: invalidateBuildProject,
          runOrder: 2,
        }),
      ],
    });

    pipeline.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codebuild:StartBuild'],
        resources: [buildProject.projectArn, invalidateBuildProject.projectArn],
        effect: iam.Effect.ALLOW,
      })
    );
  }
}
