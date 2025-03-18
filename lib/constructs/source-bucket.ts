/**
 * Source Bucket for SaaS EKS Architecture
 *
 * This construct creates an S3 bucket that serves as a source for CodeBuild projects.
 * It packages a directory as an asset and makes it available as a CodeBuild source.
 *
 * Key components:
 * - S3 bucket for storing source code assets
 * - Asset packaging with configurable exclusions
 * - CodeBuild source configuration
 */
import { IgnoreMode } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { ISource } from 'aws-cdk-lib/aws-codebuild';
import * as aws_s3 from 'aws-cdk-lib/aws-s3';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';

/**
 * Properties for configuring the Source Bucket
 */
export interface SourceBucketProps {
  /** Name identifier for the source bucket */
  readonly name: string;
  /** Directory path containing the source assets */
  readonly assetDirectory: string;
  /** Optional list of file/directory patterns to exclude */
  readonly excludes?: string[];
  /** Optional ignore mode for the asset */
  readonly ignoreMode?: IgnoreMode;
}

/**
 * Represents a source bucket for the CodeBuild project.
 */
export class SourceBucket extends Construct {
  /** CodeBuild source configuration */
  readonly source: ISource;
  /** The S3 bucket containing the source assets */
  bucket: aws_s3.IBucket;
  /** The S3 object key for the source assets */
  key: string;

  constructor(scope: Construct, id: string, props: SourceBucketProps) {
    super(scope, id);

    // Create an asset from the specified directory
    const directoryAsset = new Asset(this, `${props.name}-assets`, {
      path: props.assetDirectory,
      exclude: props.excludes,
      ignoreMode: props.ignoreMode,
    });

    // Reference the bucket created by the asset
    this.bucket = aws_s3.Bucket.fromBucketName(
      this,
      `${id}-asset-bucket`,
      directoryAsset.s3BucketName
    );
    this.key = directoryAsset.s3ObjectKey;

    // Create a CodeBuild source from the S3 bucket
    this.source = codebuild.Source.s3({
      bucket: this.bucket,
      path: this.key,
    });
  }
}
