import { DbAdapter } from "./adapter.js";
import mysql from "mysql2/promise";
import { Signer } from "@aws-sdk/rds-signer";

/**
 * MySQL database adapter implementation with Connection Pooling
 */
export class MysqlAdapter implements DbAdapter {
  private pool: mysql.Pool | null = null;
  private config: mysql.PoolOptions;
  private host: string;
  private database: string;
  private awsIamAuth: boolean;
  private awsRegion?: string;

  constructor(connectionInfo: {
    host: string;
    database: string;
    user?: string;
    password?: string;
    port?: number;
    ssl?: boolean | object;
    connectionTimeout?: number;
    awsIamAuth?: boolean;
    awsRegion?: string;
  }) {
    this.host = connectionInfo.host;
    this.database = connectionInfo.database;
    this.awsIamAuth = connectionInfo.awsIamAuth || false;
    this.awsRegion = connectionInfo.awsRegion;
    this.config = {
      host: connectionInfo.host,
      database: connectionInfo.database,
      port: connectionInfo.port || 3306,
      user: connectionInfo.user,
      password: connectionInfo.password,
      connectTimeout: connectionInfo.connectionTimeout || 30000,
      multipleStatements: true,
      // Pool configuration for persistent connections
      waitForConnections: true,
      connectionLimit: 5,              // Reducido para cPanel
      maxIdle: 5,                      // Reducido para cPanel
      idleTimeout: 30000,              // 30 segundos - más agresivo
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 5000,     // 5 segundos - más frecuente para cPanel
    };
    if (typeof connectionInfo.ssl === 'object' || typeof connectionInfo.ssl === 'string') {
      this.config.ssl = connectionInfo.ssl;
    } else if (connectionInfo.ssl === true) {
      // For AWS IAM authentication, configure SSL appropriately for RDS
      if (this.awsIamAuth) {
        this.config.ssl = {
          rejectUnauthorized: false // AWS RDS handles certificate validation
        };
      } else {
        this.config.ssl = {};
      }
    }
    // Validate port
    if (connectionInfo.port && typeof connectionInfo.port !== 'number') {
      const parsedPort = parseInt(connectionInfo.port as any, 10);
      if (isNaN(parsedPort)) {
        throw new Error(`Invalid port value for MySQL: ${connectionInfo.port}`);
      }
      this.config.port = parsedPort;
    }
    // Log the port for debugging
    console.error(`[DEBUG] MySQL connection will use port: ${this.config.port}`);
  }

  /**
   * Generate AWS RDS authentication token
   */
  private async generateAwsAuthToken(): Promise<string> {
    if (!this.awsRegion) {
      throw new Error("AWS region is required for IAM authentication");
    }

    if (!this.config.user) {
      throw new Error("AWS username is required for IAM authentication");
    }

    try {
      console.info(`[INFO] Generating AWS auth token for region: ${this.awsRegion}, host: ${this.host}, user: ${this.config.user}`);

      const signer = new Signer({
        region: this.awsRegion,
        hostname: this.host,
        port: this.config.port || 3306,
        username: this.config.user,
      });

      const token = await signer.getAuthToken();
      console.info(`[INFO] AWS auth token generated successfully`);
      return token;
    } catch (err) {
      console.error(`[ERROR] Failed to generate AWS auth token: ${(err as Error).message}`);
      throw new Error(`AWS IAM authentication failed: ${(err as Error).message}. Please check your AWS credentials and IAM permissions.`);
    }
  }

  /**
   * Initialize MySQL connection pool
   */
  async init(): Promise<void> {
    try {
      console.info(`[INFO] Connecting to MySQL: ${this.host}, Database: ${this.database}`);

      // Handle AWS IAM authentication
      if (this.awsIamAuth) {
        console.info(`[INFO] Using AWS IAM authentication for user: ${this.config.user}`);

        try {
          const authToken = await this.generateAwsAuthToken();

          // Create a new config with the generated token as password
          const awsConfig = {
            ...this.config,
            password: authToken
          };

          this.pool = mysql.createPool(awsConfig);
        } catch (err) {
          console.error(`[ERROR] AWS IAM authentication failed: ${(err as Error).message}`);
          throw new Error(`AWS IAM authentication failed: ${(err as Error).message}`);
        }
      } else {
        this.pool = mysql.createPool(this.config);
      }

      // Test the pool with a simple query
      await this.pool.query('SELECT 1');
      console.info(`[INFO] MySQL connection pool established successfully`);
    } catch (err) {
      console.error(`[ERROR] MySQL connection error: ${(err as Error).message}`);
      if (this.awsIamAuth) {
        throw new Error(`Failed to connect to MySQL with AWS IAM authentication: ${(err as Error).message}. Please verify your AWS credentials, IAM permissions, and RDS configuration.`);
      } else {
        throw new Error(`Failed to connect to MySQL: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Check if pool needs to be reinitialized
   */
  private async ensureConnection(): Promise<void> {
    if (!this.pool) {
      console.warn(`[WARN] Pool not initialized, reinitializing...`);
      await this.init();
      return;
    }

    try {
      // Test pool connectivity with a quick query
      await this.pool.query('SELECT 1');
    } catch (err) {
      console.error(`[ERROR] Pool connection test failed: ${(err as Error).message}`);
      console.info(`[INFO] Attempting to reinitialize connection pool...`);

      // Close the old pool if it exists
      try {
        await this.pool.end();
      } catch (closeErr) {
        console.error(`[ERROR] Error closing old pool: ${(closeErr as Error).message}`);
      }

      this.pool = null;
      await this.init();
    }
  }

  /**
   * Execute a SQL query and get all results
   */
  async all(query: string, params: any[] = []): Promise<any[]> {
    await this.ensureConnection();

    try {
      const [rows] = await this.pool!.execute(query, params);
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      const errorMsg = (err as Error).message;

      // If connection error, try once more after reconnecting
      if (errorMsg.includes('closed') || errorMsg.includes('PROTOCOL_CONNECTION_LOST')) {
        console.warn(`[WARN] Connection lost, attempting reconnection...`);
        await this.ensureConnection();
        const [rows] = await this.pool!.execute(query, params);
        return Array.isArray(rows) ? rows : [];
      }

      throw new Error(`MySQL query error: ${errorMsg}`);
    }
  }

  /**
   * Execute a SQL query that modifies data
   */
  async run(query: string, params: any[] = []): Promise<{ changes: number, lastID: number }> {
    await this.ensureConnection();

    try {
      const [result]: any = await this.pool!.execute(query, params);
      const changes = result.affectedRows || 0;
      const lastID = result.insertId || 0;
      return { changes, lastID };
    } catch (err) {
      const errorMsg = (err as Error).message;

      // If connection error, try once more after reconnecting
      if (errorMsg.includes('closed') || errorMsg.includes('PROTOCOL_CONNECTION_LOST')) {
        console.warn(`[WARN] Connection lost, attempting reconnection...`);
        await this.ensureConnection();
        const [result]: any = await this.pool!.execute(query, params);
        const changes = result.affectedRows || 0;
        const lastID = result.insertId || 0;
        return { changes, lastID };
      }

      throw new Error(`MySQL query error: ${errorMsg}`);
    }
  }

  /**
   * Execute multiple SQL statements
   */
  async exec(query: string): Promise<void> {
    await this.ensureConnection();

    try {
      await this.pool!.query(query);
    } catch (err) {
      const errorMsg = (err as Error).message;

      // If connection error, try once more after reconnecting
      if (errorMsg.includes('closed') || errorMsg.includes('PROTOCOL_CONNECTION_LOST')) {
        console.warn(`[WARN] Connection lost, attempting reconnection...`);
        await this.ensureConnection();
        await this.pool!.query(query);
        return;
      }

      throw new Error(`MySQL batch error: ${errorMsg}`);
    }
  }

  /**
   * Close the database connection pool
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  /**
   * Get database metadata
   */
  getMetadata(): { name: string; type: string; server: string; database: string } {
    return {
      name: "MySQL",
      type: "mysql",
      server: this.host,
      database: this.database,
    };
  }

  /**
   * Get database-specific query for listing tables
   */
  getListTablesQuery(): string {
    return `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = '${this.database}'`;
  }

  /**
   * Get database-specific query for describing a table
   */
  getDescribeTableQuery(tableName: string): string {
    return `DESCRIBE \`${tableName}\``;
  }
}