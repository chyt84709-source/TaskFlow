import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const bucket = process.env.AWS_S3_BUCKET
  || process.env.AWS_S3_BUCKET_NAME
  || process.env.S3_BUCKET_NAME
  || process.env.AWS_BUCKET_NAME
  || process.env.S3_BUCKET;
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || process.env.S3_REGION;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.AWS_S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY;
const sessionToken = process.env.AWS_SESSION_TOKEN || process.env.AWS_S3_SESSION_TOKEN;
const endpoint = process.env.AWS_ENDPOINT_URL_S3
  || process.env.AWS_S3_ENDPOINT
  || process.env.S3_ENDPOINT_URL
  || process.env.S3_ENDPOINT;
const forcePathStyle = process.env.AWS_S3_FORCE_PATH_STYLE === 'true'
  || process.env.S3_FORCE_PATH_STYLE === 'true';
const serverSideEncryption = process.env.S3_SERVER_SIDE_ENCRYPTION === 'none'
  ? undefined
  : process.env.S3_SERVER_SIDE_ENCRYPTION || 'AES256';

export const objectStorageEnabled = Boolean(bucket && region);

const client = objectStorageEnabled ? new S3Client({
  region,
  ...(endpoint ? { endpoint } : {}),
  forcePathStyle,
  ...(accessKeyId && secretAccessKey ? {
    credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
  } : {})
}) : null;

function s3Client() {
  if (!client || !bucket) {
    throw new Error('S3 storage is not configured. Set AWS_S3_BUCKET and AWS_REGION.');
  }
  return { client, bucket };
}

export function isS3Object(filename) {
  return typeof filename === 'string' && filename.startsWith('s3:');
}

export async function createObjectUploadUrl(key, contentType, expiresIn = 600) {
  const { client: s3, bucket: bucketName } = s3Client();
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    ContentType: contentType,
    ...(serverSideEncryption ? { ServerSideEncryption: serverSideEncryption } : {})
  });
  const url = await getSignedUrl(s3, command, { expiresIn });
  return {
    url,
    headers: {
      'Content-Type': contentType,
      ...(serverSideEncryption ? { 'x-amz-server-side-encryption': serverSideEncryption } : {})
    }
  };
}

export async function inspectObject(key) {
  const { client: s3, bucket: bucketName } = s3Client();
  const result = await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
  return { size: Number(result.ContentLength || 0), contentType: result.ContentType || '' };
}

export async function promoteObject(sourceKey, destinationKey, contentType) {
  const { client: s3, bucket: bucketName } = s3Client();
  const copySource = `${bucketName}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`;
  await s3.send(new CopyObjectCommand({
    Bucket: bucketName,
    Key: destinationKey,
    CopySource: copySource,
    ContentType: contentType,
    MetadataDirective: 'REPLACE',
    ...(serverSideEncryption ? { ServerSideEncryption: serverSideEncryption } : {})
  }));
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: sourceKey }));
  } catch (error) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: destinationKey }))
      .catch((cleanupError) => console.error('Unable to remove copied S3 upload after promotion failed:', cleanupError));
    throw error;
  }
}

export async function deleteObject(key) {
  const { client: s3, bucket: bucketName } = s3Client();
  await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
}

export async function createObjectDownloadUrl(key, expiresIn = 300, filename) {
  const { client: s3, bucket: bucketName } = s3Client();
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
    ...(filename ? {
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
    } : {})
  });
  return getSignedUrl(s3, command, { expiresIn });
}

export async function readObjectRange(key, range) {
  const { client: s3, bucket: bucketName } = s3Client();
  const result = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key, Range: range }));
  return result.Body.transformToByteArray();
}
