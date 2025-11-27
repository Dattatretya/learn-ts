# CloudWatch Logger Implementation Guide

This document explains the CloudWatch logger implementation, how to configure AWS credentials for local development, and how to view logs in AWS CloudWatch.

## Table of Contents

1. [Logger Implementation Details](#logger-implementation-details)
2. [Setting Up AWS Credentials for Local Development](#setting-up-aws-credentials-for-local-development)
3. [Configuring CloudWatch Logs](#configuring-cloudwatch-logs)
4. [Environment Variables](#environment-variables)
5. [Testing the Logger](#testing-the-logger)
6. [Viewing Logs in CloudWatch](#viewing-logs-in-cloudwatch)
7. [Common Errors and Troubleshooting](#common-errors-and-troubleshooting)

---

## Logger Implementation Details

### File: `src/utils/logger.ts`

#### **Lines 1-8: Imports and Type Definitions**

```typescript
import { CloudWatchLogsClient, PutLogEventsCommand, CreateLogGroupCommand, CreateLogStreamCommand, DescribeLogStreamsCommand } from '@aws-sdk/client-cloudwatch-logs';
```

**Explanation:**
- Imports necessary classes from AWS SDK v3 for CloudWatch Logs
- `CloudWatchLogsClient`: Main client for making API calls to CloudWatch Logs
- `PutLogEventsCommand`: Command to send log events to CloudWatch
- `CreateLogGroupCommand`: Command to create a log group if it doesn't exist
- `CreateLogStreamCommand`: Command to create a log stream within a log group
- `DescribeLogStreamsCommand`: Command to retrieve information about log streams (needed for sequence tokens)

```typescript
interface LogEntry {
  message: string;
  level: string;
  metadata?: Record<string, any>;
  timestamp: number;
}
```

**Explanation:**
- Defines the structure of a log entry object
- `message`: The actual log message text
- `level`: Log severity level (info, error, warn, debug)
- `metadata`: Optional additional context data (key-value pairs)
- `timestamp`: Unix timestamp in milliseconds when the log was created

#### **Lines 10-20: Class Properties**

```typescript
class CloudWatchLogger {
  private client: CloudWatchLogsClient | null = null;
  private logGroupName: string;
  private region: string;
  private enabled: boolean = false;
  private logStreamName: string;
  private sequenceToken: string | undefined;
  private logQueue: LogEntry[] = [];
  private batchSize: number = 10;
  private flushInterval: number = 5000; // 5 seconds
  private flushTimer: NodeJS.Timeout | null = null;
```

**Explanation:**
- `client`: AWS CloudWatch Logs client instance (null if CloudWatch is disabled)
- `logGroupName`: Name of the CloudWatch log group where logs will be stored
- `region`: AWS region where the log group exists (e.g., 'us-east-1')
- `enabled`: Flag indicating whether CloudWatch logging is active
- `logStreamName`: Unique name for this application instance's log stream
- `sequenceToken`: Token required by CloudWatch to ensure log events are in order
- `logQueue`: Array that buffers log entries before sending them in batches
- `batchSize`: Maximum number of logs to send in a single batch (10 logs)
- `flushInterval`: Time in milliseconds between automatic log flushes (5000ms = 5 seconds)
- `flushTimer`: Reference to the interval timer for periodic flushing

#### **Lines 22-54: Constructor**

```typescript
constructor() {
  this.logGroupName = process.env.CLOUDWATCH_LOG_GROUP || '';
  this.region = process.env.AWS_REGION || 'us-east-1';
  this.logStreamName = `app-${Date.now()}`;
```

**Explanation:**
- Reads the log group name from environment variable `CLOUDWATCH_LOG_GROUP`, defaults to empty string
- Reads AWS region from environment variable `AWS_REGION`, defaults to 'us-east-1'
- Creates a unique log stream name using current timestamp (e.g., "app-1699123456789")

```typescript
// Initialize CloudWatch client if log group is configured
if (this.logGroupName) {
  try {
    this.client = new CloudWatchLogsClient({
      region: this.region,
      credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined, // Will use IAM role if credentials not provided
    });
```

**Explanation:**
- Only initializes CloudWatch if `CLOUDWATCH_LOG_GROUP` environment variable is set
- Creates a new CloudWatch Logs client with the specified region
- Uses environment variables for AWS credentials if provided, otherwise relies on IAM roles (useful for EC2/Lambda deployments)

```typescript
this.enabled = true;
this.initializeLogGroup().catch(() => {
  // If initialization fails, fallback to console
  this.enabled = false;
});
```

**Explanation:**
- Sets `enabled` to true once client is created
- Asynchronously initializes the log group and stream
- If initialization fails, disables CloudWatch logging and falls back to console logging

```typescript
} catch (error) {
  console.warn('CloudWatch Logger initialization failed, falling back to console.log:', error);
  this.enabled = false;
}
```

**Explanation:**
- Catches any errors during client creation (e.g., invalid credentials)
- Logs a warning and disables CloudWatch, ensuring the application continues to work

```typescript
// Start periodic flush
if (this.enabled) {
  this.startFlushTimer();
}
```

**Explanation:**
- Starts a timer that automatically flushes logs every 5 seconds if CloudWatch is enabled

#### **Lines 56-89: Log Group Initialization**

```typescript
private async initializeLogGroup(): Promise<void> {
  if (!this.client) return;
```

**Explanation:**
- Private async method that sets up the log group and stream in CloudWatch
- Returns early if client is not initialized

```typescript
try {
  // Create log group if it doesn't exist
  await this.client.send(
    new CreateLogGroupCommand({
      logGroupName: this.logGroupName,
    })
  );
} catch (error: any) {
  // Log group might already exist, which is fine
  if (error.name !== 'ResourceAlreadyExistsException') {
    throw error;
  }
}
```

**Explanation:**
- Attempts to create the log group in CloudWatch
- If the log group already exists, the error is ignored (idempotent operation)
- Other errors are re-thrown

```typescript
try {
  // Create log stream
  await this.client.send(
    new CreateLogStreamCommand({
      logGroupName: this.logGroupName,
      logStreamName: this.logStreamName,
    })
  );
} catch (error: any) {
  // Log stream might already exist, try to get sequence token
  if (error.name === 'ResourceAlreadyExistsException') {
    await this.getSequenceToken();
  } else {
    throw error;
  }
}
```

**Explanation:**
- Creates a log stream within the log group
- If stream already exists, retrieves the sequence token for that stream
- Sequence token is required to maintain log ordering in CloudWatch

#### **Lines 91-109: Get Sequence Token**

```typescript
private async getSequenceToken(): Promise<void> {
  if (!this.client) return;

  try {
    const response = await this.client.send(
      new DescribeLogStreamsCommand({
        logGroupName: this.logGroupName,
        logStreamNamePrefix: this.logStreamName,
      })
    );

    const stream = response.logStreams?.find(
      (s) => s.logStreamName === this.logStreamName
    );
    this.sequenceToken = stream?.uploadSequenceToken;
```

**Explanation:**
- Retrieves information about log streams matching the stream name
- Finds the exact stream and extracts its upload sequence token
- Sequence token is needed to append logs in the correct order

#### **Lines 111-178: Flush Logs to CloudWatch**

```typescript
private async flushLogs(): Promise<void> {
  if (!this.client || this.logQueue.length === 0) return;

  const logsToSend = this.logQueue.splice(0, this.batchSize);
```

**Explanation:**
- Sends queued logs to CloudWatch
- Returns early if client not initialized or queue is empty
- Removes up to `batchSize` (10) logs from the queue for sending

```typescript
const logEvents = logsToSend.map((entry) => ({
  message: JSON.stringify({
    level: entry.level,
    message: entry.message,
    metadata: entry.metadata,
    timestamp: new Date(entry.timestamp).toISOString(),
  }),
  timestamp: entry.timestamp,
}));
```

**Explanation:**
- Converts log entries to CloudWatch log event format
- Creates JSON string with all log information
- Includes ISO timestamp for better readability in CloudWatch

```typescript
try {
  const command = new PutLogEventsCommand({
    logGroupName: this.logGroupName,
    logStreamName: this.logStreamName,
    logEvents,
    sequenceToken: this.sequenceToken,
  });

  const response = await this.client.send(command);
  this.sequenceToken = response.nextSequenceToken;
```

**Explanation:**
- Creates command to send log events to CloudWatch
- Includes sequence token to maintain log ordering
- Sends command and updates sequence token from response for next batch

```typescript
} catch (error: any) {
  // If we get InvalidSequenceTokenException, refresh the token and retry once
  if (error.name === 'InvalidSequenceTokenException' && error.expectedSequenceToken) {
    this.sequenceToken = error.expectedSequenceToken;
    // ... retry logic
```

**Explanation:**
- Handles invalid sequence token errors (can happen with concurrent writes)
- Uses the expected token from the error and retries once
- On retry failure, falls back to console logging for that batch

#### **Lines 192-231: Core Logging Method**

```typescript
private log(level: string, message: string, metadata?: Record<string, any>): void {
  const logEntry: LogEntry = {
    message,
    level,
    metadata,
    timestamp: Date.now(),
  };
```

**Explanation:**
- Core internal method that creates log entries
- Creates a log entry object with current timestamp

```typescript
// Always log to console for immediate visibility
const formattedMessage = `[${level.toUpperCase()}] ${message}`;
if (metadata) {
  if (level === 'error') {
    console.error(formattedMessage, metadata);
  } else if (level === 'warn') {
    console.warn(formattedMessage, metadata);
  } else {
    console.log(formattedMessage, metadata);
  }
}
```

**Explanation:**
- Always logs to console for immediate debugging
- Formats message with log level prefix (e.g., "[INFO] message")
- Uses appropriate console method based on log level

```typescript
// Queue for CloudWatch if enabled
if (this.enabled) {
  this.logQueue.push(logEntry);

  // Flush immediately if queue is full
  if (this.logQueue.length >= this.batchSize) {
    this.flushLogs().catch((error) => {
      console.error('Error flushing logs immediately:', error);
    });
  }
}
```

**Explanation:**
- Adds log to queue if CloudWatch is enabled
- Triggers immediate flush if queue reaches batch size (prevents overflow)

#### **Lines 233-259: Public Logging Methods**

```typescript
public info(message: string, metadata?: Record<string, any>): void {
  this.log('info', message, metadata);
}

public error(message: string, error?: Error | any, metadata?: Record<string, any>): void {
  const errorMetadata = {
    ...metadata,
    ...(error instanceof Error
      ? {
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        }
      : { error }),
  };
  this.log('error', message, errorMetadata);
}
```

**Explanation:**
- Public methods for different log levels
- `error()` method intelligently extracts Error object properties (name, message, stack) for better error tracking

#### **Lines 261-271: Shutdown Method**

```typescript
public async shutdown(): Promise<void> {
  if (this.flushTimer) {
    clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  // Flush remaining logs
  while (this.logQueue.length > 0) {
    await this.flushLogs();
  }
}
```

**Explanation:**
- Graceful shutdown method
- Stops the periodic flush timer
- Ensures all remaining logs are sent before application exits

---

## Setting Up AWS Credentials for Local Development

### Method 1: AWS CLI Configuration (Recommended)

1. **Install AWS CLI:**
   ```bash
   # macOS
   brew install awscli

   # Or download from: https://aws.amazon.com/cli/
   ```

2. **Configure AWS Credentials:**
   ```bash
   aws configure
   ```
   
   You'll be prompted for:
   - **AWS Access Key ID**: Your AWS access key
   - **AWS Secret Access Key**: Your AWS secret key
   - **Default region name**: e.g., `us-east-1`
   - **Default output format**: `json`

   This creates a credentials file at `~/.aws/credentials` and config at `~/.aws/config`

3. **Verify Configuration:**
   ```bash
   aws sts get-caller-identity
   ```
   
   This should return your AWS account information.

### Method 2: Environment Variables

1. **Create a `.env` file** in your project root:
   ```env
   CLOUDWATCH_LOG_GROUP=my-app-logs
   AWS_REGION=us-east-1
   AWS_ACCESS_KEY_ID=your-access-key-id
   AWS_SECRET_ACCESS_KEY=your-secret-access-key
   ```

2. **Never commit `.env` to git!** Add it to `.gitignore`:
   ```gitignore
   .env
   ```

### Method 3: IAM Role (For AWS Deployments)

When deployed on AWS (EC2, Lambda, ECS), the logger will automatically use IAM roles for authentication - no credentials needed in environment variables.

---

## Configuring CloudWatch Logs

### Step 1: Create an IAM User (For Local Development)

1. Go to AWS Console → IAM → Users → Add users
2. Create a user with programmatic access
3. Attach the policy `CloudWatchLogsFullAccess` (or create a custom policy with these permissions):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "logs:CreateLogGroup",
           "logs:CreateLogStream",
           "logs:PutLogEvents",
           "logs:DescribeLogStreams"
         ],
         "Resource": "arn:aws:logs:*:*:*"
       }
     ]
   }
   ```
4. Save the Access Key ID and Secret Access Key

### Step 2: Set Environment Variables

Add to your `.env` file:
```env
CLOUDWATCH_LOG_GROUP=typescript-backend-practice
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

**Note:** Replace with your actual credentials from Step 1.

### Step 3: The Logger Will Auto-Create Resources

The logger automatically creates:
- **Log Group**: If it doesn't exist
- **Log Stream**: For each application instance (named with timestamp)

No manual setup required in CloudWatch Console!

---

## Environment Variables

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `CLOUDWATCH_LOG_GROUP` | Name of the CloudWatch log group | `my-app-logs` |

### Optional Variables

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `AWS_REGION` | AWS region for CloudWatch | `us-east-1` | `us-west-2` |
| `AWS_ACCESS_KEY_ID` | AWS access key (for local dev) | Uses IAM role if not set | `AKIAIOSFODNN7EXAMPLE` |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key (for local dev) | Uses IAM role if not set | `wJalrXUtnFEMI/K7MDENG...` |

**Important:** If `CLOUDWATCH_LOG_GROUP` is not set, the logger will only use console.log (graceful degradation).

---

## Testing the Logger

1. **Start your application:**
   ```bash
   npm start
   ```

2. **Check console output** - You should see logs with level prefixes:
   ```
   [INFO] Server is running on http://localhost:3000
   [INFO] Connected to MongoDB
   ```

3. **Check CloudWatch Console** (after a few seconds):
   - Go to AWS Console → CloudWatch → Logs → Log groups
   - Find your log group (e.g., `typescript-backend-practice`)
   - Click on it to see log streams
   - Click on a log stream to see the logs

---

## Viewing Logs in CloudWatch

### Step 1: Access CloudWatch Console

1. Log in to [AWS Console](https://console.aws.amazon.com/)
2. Navigate to **CloudWatch** service
3. Click on **Logs** in the left sidebar
4. Click on **Log groups**

### Step 2: Find Your Log Group

1. Search for your log group name (e.g., `typescript-backend-practice`)
2. Click on the log group name

### Step 3: View Log Streams

1. You'll see a list of log streams (one per application instance)
2. Log streams are named like `app-1699123456789` (timestamp-based)
3. Click on a log stream to view its logs

### Step 4: Read Logs

1. Logs are displayed in chronological order
2. Each log entry shows:
   - **Timestamp**: When the log was created
   - **Message**: JSON-formatted log with level, message, and metadata

Example log entry in CloudWatch:
```json
{
  "level": "info",
  "message": "Server is running on http://localhost:3000",
  "metadata": {
    "port": "3000"
  },
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

### Step 5: Search and Filter Logs

1. Use the search box to filter logs by keyword
2. Use time range selector to view logs from specific periods
3. CloudWatch Insights allows advanced querying:
   ```sql
   fields @timestamp, level, message
   | filter level = "error"
   | sort @timestamp desc
   | limit 100
   ```

---

## Common Errors and Troubleshooting

### Error 1: "Cannot find module '@aws-sdk/client-cloudwatch-logs'"

**Solution:**
```bash
npm install @aws-sdk/client-cloudwatch-logs
```

### Error 2: "CloudWatch Logger initialization failed"

**Possible Causes:**
- Missing or invalid AWS credentials
- Incorrect AWS region
- Network connectivity issues

**Solutions:**
1. Verify credentials:
   ```bash
   aws sts get-caller-identity
   ```

2. Check environment variables are set correctly

3. The logger will fall back to console.log - check console output

### Error 3: "ResourceAlreadyExistsException"

**Explanation:** This is normal! It means the log group or stream already exists. The logger handles this automatically.

**Solution:** No action needed - this is expected behavior.

### Error 4: "InvalidSequenceTokenException"

**Explanation:** This happens when logs are written concurrently. The logger automatically retries with the correct token.

**Solution:** No action needed - the logger handles this automatically.

### Error 5: "AccessDeniedException"

**Possible Causes:**
- IAM user/role doesn't have CloudWatch Logs permissions
- Missing IAM policies

**Solution:**
1. Check IAM permissions for the user/role
2. Ensure these permissions are granted:
   - `logs:CreateLogGroup`
   - `logs:CreateLogStream`
   - `logs:PutLogEvents`
   - `logs:DescribeLogStreams`

### Error 6: Logs not appearing in CloudWatch

**Troubleshooting Steps:**
1. **Check if CloudWatch is enabled:**
   - Verify `CLOUDWATCH_LOG_GROUP` environment variable is set
   - Check console for initialization warnings

2. **Wait for flush interval:**
   - Logs are batched and sent every 5 seconds
   - Or when batch size (10 logs) is reached

3. **Check AWS region:**
   - Ensure `AWS_REGION` matches where you're looking in CloudWatch Console

4. **Verify credentials:**
   ```bash
   aws logs describe-log-groups --log-group-name-prefix your-log-group-name
   ```

5. **Check CloudWatch Console:**
   - Logs may be in a different region
   - Check all regions if unsure

### Error 7: "Log group does not exist" (after creation attempt)

**Solution:**
1. The logger creates the log group automatically
2. Wait a few seconds and refresh CloudWatch Console
3. If still not visible, check IAM permissions for `logs:CreateLogGroup`

---

## Best Practices

1. **Never commit AWS credentials to git**
   - Use `.env` file (already in `.gitignore`)
   - Use IAM roles for production deployments

2. **Use structured metadata:**
   ```typescript
   logger.info('User registered', { userId: user.id, email: user.email });
   ```

3. **Use appropriate log levels:**
   - `info`: General information
   - `warn`: Warnings that don't stop execution
   - `error`: Errors that need attention
   - `debug`: Detailed debugging information

4. **Shutdown gracefully:**
   ```typescript
   process.on('SIGTERM', async () => {
     await logger.shutdown();
     process.exit(0);
   });
   ```

5. **Monitor log costs:**
   - CloudWatch Logs charges for data ingested and stored
   - Set up log retention policies
   - Consider log group lifecycle policies

---

## Summary

The CloudWatch logger provides:
- ✅ Automatic log group/stream creation
- ✅ Graceful fallback to console.log
- ✅ Batch logging for efficiency
- ✅ Structured JSON logs
- ✅ Error handling and retries
- ✅ Zero configuration needed (auto-detects IAM roles on AWS)

Just set the `CLOUDWATCH_LOG_GROUP` environment variable and you're ready to go!

