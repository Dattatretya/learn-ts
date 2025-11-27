import { CloudWatchLogsClient, PutLogEventsCommand, CreateLogGroupCommand, CreateLogStreamCommand, DescribeLogStreamsCommand } from '@aws-sdk/client-cloudwatch-logs';

interface LogEntry {
  message: string;
  level: string;
  metadata?: Record<string, any>;
  timestamp: number;
}

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

  constructor() {
    this.logGroupName = process.env.CLOUDWATCH_LOG_GROUP || '';
    this.region = process.env.AWS_REGION || 'us-east-1';
    this.logStreamName = `app-${Date.now()}`;

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
        this.enabled = true;
        this.initializeLogGroup().catch(() => {
          // If initialization fails, fallback to console
          this.enabled = false;
        });
      } catch (error) {
        console.warn('CloudWatch Logger initialization failed, falling back to console.log:', error);
        this.enabled = false;
      }
    }

    // Start periodic flush
    if (this.enabled) {
      this.startFlushTimer();
    }
  }

  private async initializeLogGroup(): Promise<void> {
    if (!this.client) return;

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
  }

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
    } catch (error) {
      console.warn('Failed to get sequence token:', error);
    }
  }

  private async flushLogs(): Promise<void> {
    if (!this.client || this.logQueue.length === 0) return;

    const logsToSend = this.logQueue.splice(0, this.batchSize);

    const logEvents = logsToSend.map((entry) => ({
      message: JSON.stringify({
        level: entry.level,
        message: entry.message,
        metadata: entry.metadata,
        timestamp: new Date(entry.timestamp).toISOString(),
      }),
      timestamp: entry.timestamp,
    }));

    try {
      const command = new PutLogEventsCommand({
        logGroupName: this.logGroupName,
        logStreamName: this.logStreamName,
        logEvents,
        sequenceToken: this.sequenceToken,
      });

      const response = await this.client.send(command);
      this.sequenceToken = response.nextSequenceToken;
    } catch (error: any) {
      // If we get InvalidSequenceTokenException, refresh the token and retry once
      if (error.name === 'InvalidSequenceTokenException' && error.expectedSequenceToken) {
        this.sequenceToken = error.expectedSequenceToken;
        try {
          const retryCommand = new PutLogEventsCommand({
            logGroupName: this.logGroupName,
            logStreamName: this.logStreamName,
            logEvents,
            sequenceToken: this.sequenceToken,
          });
          const retryResponse = await this.client.send(retryCommand);
          this.sequenceToken = retryResponse.nextSequenceToken;
        } catch (retryError) {
          console.error('Failed to send logs to CloudWatch after retry:', retryError);
          // Fallback to console for failed logs
          logsToSend.forEach((entry) => {
            const formattedMessage = `[${entry.level.toUpperCase()}] ${entry.message}`;
            if (entry.level === 'error') {
              console.error(formattedMessage, entry.metadata || '');
            } else if (entry.level === 'warn') {
              console.warn(formattedMessage, entry.metadata || '');
            } else {
              console.log(formattedMessage, entry.metadata || '');
            }
          });
        }
      } else {
        console.error('Failed to send logs to CloudWatch:', error);
        // Fallback to console for failed logs
        logsToSend.forEach((entry) => {
          const formattedMessage = `[${entry.level.toUpperCase()}] ${entry.message}`;
          if (entry.level === 'error') {
            console.error(formattedMessage, entry.metadata || '');
          } else if (entry.level === 'warn') {
            console.warn(formattedMessage, entry.metadata || '');
          } else {
            console.log(formattedMessage, entry.metadata || '');
          }
        });
      }
    }
  }

  private startFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    this.flushTimer = setInterval(() => {
      this.flushLogs().catch((error) => {
        console.error('Error flushing logs:', error);
      });
    }, this.flushInterval);
  }

  private log(level: string, message: string, metadata?: Record<string, any>): void {
    const logEntry: LogEntry = {
      message,
      level,
      metadata,
      timestamp: Date.now(),
    };

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
    } else {
      if (level === 'error') {
        console.error(formattedMessage);
      } else if (level === 'warn') {
        console.warn(formattedMessage);
      } else {
        console.log(formattedMessage);
      }
    }

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
  }

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

  public warn(message: string, metadata?: Record<string, any>): void {
    this.log('warn', message, metadata);
  }

  public debug(message: string, metadata?: Record<string, any>): void {
    this.log('debug', message, metadata);
  }

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
}

// Export singleton instance
export const logger = new CloudWatchLogger();

// Export class for testing
export default CloudWatchLogger;

