/**
 * API Stack for SaaS EKS Architecture
 *
 * This stack creates an API Gateway that serves as the public entry point for the SaaS application.
 * It connects to an internal Network Load Balancer (NLB) in front of the EKS cluster using a VPC Link.
 *
 * The stack supports two deployment modes:
 * 1. Default mode: Uses the API Gateway's default domain
 * 2. Custom domain mode: Uses a custom domain with Route53 and ACM certificate
 *
 * Key components:
 * - API Gateway with proxy integration to the NLB
 * - VPC Link connecting API Gateway to the private NLB
 * - Optional custom domain with SSL certificate
 * - CORS configuration for browser access
 */
import { Arn, CfnOutput, Fn, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as targets from 'aws-cdk-lib/aws-route53-targets';

/**
 * Properties for the API Stack
 */
export interface ApiStackProps extends StackProps {
  /** DNS name of the internal Network Load Balancer */
  readonly internalNLBDomain: string;
  /** VPC where the EKS cluster and NLB are deployed */
  readonly vpc: ec2.Vpc;
  /** Name of the Kubernetes ingress controller */
  readonly ingressControllerName: string;
  /** Name of the EKS cluster */
  readonly eksClusterName: string;

  /** Optional custom domain name (e.g., example.com) */
  readonly customDomain?: string;
  /** Route53 hosted zone ID for the custom domain */
  readonly hostedZoneId?: string;
}

export class ApiStack extends Stack {
  /** The URL of the deployed API (with or without custom domain) */
  readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // Determine if we're using a custom domain
    const useCustomDomain = props.customDomain ? true : false;

    // If using custom domain, get the hosted zone
    const publicHostedZone = useCustomDomain
      ? route53.PublicHostedZone.fromHostedZoneAttributes(this, 'CustomDomainPublicHostedZone', {
          hostedZoneId: props.hostedZoneId!,
          zoneName: `api.${props.customDomain!}`,
        })
      : undefined;

    // Create SSL certificate for custom domain if needed
    const apiCertificate = useCustomDomain
      ? new acm.DnsValidatedCertificate(this, 'ApiCertificate', {
          domainName: `api.${props.customDomain!}`,
          hostedZone: publicHostedZone!,
          region: 'us-east-1', // ACM certificates for API Gateway must be in us-east-1
        })
      : undefined;

    // Parse the NLB domain name to extract the NLB name and ID
    const nlbSubdomain = Fn.select(0, Fn.split('.', props.internalNLBDomain));
    const nlbSubdomainParts = Fn.split('-', nlbSubdomain);
    const nlbName = Fn.select(0, nlbSubdomainParts);
    const nlbId = Fn.select(1, nlbSubdomainParts);

    // Construct the ARN for the NLB
    const nlbArn = Arn.format(
      {
        service: 'elasticloadbalancing',
        resource: 'loadbalancer',
        resourceName: `net/${nlbName}/${nlbId}`,
      },
      this
    );

    // Import the existing NLB
    const nlb = elb.NetworkLoadBalancer.fromNetworkLoadBalancerAttributes(this, 'SaaSInternalNLB', {
      loadBalancerArn: nlbArn,
      loadBalancerDnsName: props.internalNLBDomain,
      vpc: props.vpc,
    });

    // Create VPC Link to connect API Gateway to the NLB
    const vpcLink = new apigw.VpcLink(this, 'eks-saas-vpc-link', {
      description:
        'VPCLink to connect the API Gateway with the private NLB sitting in front of the EKS cluster',
      targets: [nlb],
      vpcLinkName: 'eks-saas-vpc-link',
    });

    // Configure domain name properties if using custom domain
    const domainNameProps = useCustomDomain
      ? ({
          domainName: `api.${props.customDomain!}`,
          certificate: apiCertificate,
        } as apigw.DomainNameProps)
      : undefined;

    // Create the API Gateway
    const api = new apigw.RestApi(this, 'EKSSaaSAPI', {
      restApiName: 'EKSSaaSAPI',
      endpointTypes: [apigw.EndpointType.REGIONAL],
      domainName: domainNameProps,
      deployOptions: {
        tracingEnabled: true, // Enable X-Ray tracing
      },
      defaultMethodOptions: {
        authorizationType: apigw.AuthorizationType.NONE, // No auth by default
      },
    });

    // Add a proxy resource to handle all paths
    const proxy = api.root.addProxy({
      anyMethod: false,
    });

    // Add ANY method to the proxy resource with HTTP_PROXY integration
    proxy.addMethod(
      'ANY',
      new apigw.Integration({
        type: apigw.IntegrationType.HTTP_PROXY,
        options: {
          connectionType: apigw.ConnectionType.VPC_LINK,
          vpcLink: vpcLink,
          requestParameters: {
            'integration.request.path.proxy': 'method.request.path.proxy',
          },
        },
        integrationHttpMethod: 'ANY',
        uri: `http://${nlb.loadBalancerDnsName}/{proxy}`,
      }),
      {
        requestParameters: {
          'method.request.path.proxy': true,
        },
        authorizationType: apigw.AuthorizationType.NONE,
      }
    );

    // Add CORS support for browser access
    proxy.addCorsPreflight({
      allowOrigins: apigw.Cors.ALL_ORIGINS,
      allowMethods: apigw.Cors.ALL_METHODS,
    });

    // Create DNS record for custom domain if specified
    if (useCustomDomain) {
      new route53.ARecord(this, 'CustomDomainAliasRecord', {
        zone: publicHostedZone!,
        target: route53.RecordTarget.fromAlias(new targets.ApiGateway(api)),
        recordName: `api.${props.customDomain!}`,
      });
    }

    // Set the API URL based on whether we're using a custom domain
    this.apiUrl = useCustomDomain ? `https://api.${props.customDomain!}` : api.url;

    // Output the API URL
    new CfnOutput(this, 'APIUrl', {
      value: this.apiUrl,
    });
  }
}
