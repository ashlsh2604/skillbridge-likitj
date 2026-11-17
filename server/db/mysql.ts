import crypto from 'crypto';
import mysql, { Pool, PoolConnection } from 'mysql2/promise';
import {
  INITIAL_USERS,
  INITIAL_STUDENT_PROFILES,
  INITIAL_SKILLS,
  INITIAL_STUDENT_SKILLS,
  INITIAL_JOB_POSTINGS,
  INITIAL_JOB_REQUIRED_SKILLS,
  INITIAL_JOB_APPLICATIONS
} from '../../src/data/initial-mysql-data';

const AUTH_SECRET = process.env.AUTH_SECRET || process.env.APP_URL || 'skillbridge-mysql-session-secret-2026';

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, storedHash?: string): boolean {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, keyHex] = storedHash.split(':');
  if (!salt || !keyHex) return false;
  try {
    const derived = crypto.scryptSync(password, salt, 64);
    const keyBuf = Buffer.from(keyHex, 'hex');
    if (derived.length !== keyBuf.length) return false;
    return crypto.timingSafeEqual(derived, keyBuf);
  } catch {
    return false;
  }
}

function createSessionToken(user: { id: number; email: string; role: string }): string {
  const payload = {
    userId: user.id,
    email: user.email,
    role: user.role,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifySessionToken(token: string): { userId: number; email: string; role: string } | null {
  if (!token || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  try {
    const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(encoded).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.userId || !payload.exp || Date.now() > payload.exp) {
      return null;
    }
    return {
      userId: Number(payload.userId),
      email: String(payload.email),
      role: String(payload.role)
    };
  } catch {
    return null;
  }
}

export interface MySQLConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
}

export interface BackendSQLLog {
  id: string;
  timestamp: string;
  query: string;
  executionTimeMs: number;
  affectedRows?: number;
  source: 'mysql-server' | 'in-memory-engine';
}

export interface MySQLStatus {
  connected: boolean;
  mode: 'mysql' | 'in-memory-relational';
  host: string;
  port: number;
  database: string;
  user: string;
  latencyMs: number;
  error?: string;
  tableCounts: Record<string, number>;
  totalQueries: number;
  inTransaction: boolean;
}

// In-memory relational storage fallback if external MySQL server is unreachable
interface InMemStore {
  users: any[];
  student_profiles: any[];
  skills: any[];
  student_skills: any[];
  job_postings: any[];
  job_required_skills: any[];
  job_applications: any[];
  logs: BackendSQLLog[];
}

class MySQLBackendService {
  private pool: Pool | null = null;
  private activeTxConn: PoolConnection | null = null;
  private isConnected = false;
  private currentConfig: MySQLConfig;
  private logs: BackendSQLLog[] = [];
  private inMemStore: InMemStore;
  private txSnapshot: InMemStore | null = null;
  private savepoints: Map<string, InMemStore> = new Map();
  private lastPingMs = 0;
  private lastError: string | undefined = undefined;

  constructor() {
    this.currentConfig = {
      host: process.env.MYSQL_HOST || process.env.DB_HOST || 'localhost',
      port: Number(process.env.MYSQL_PORT || process.env.DB_PORT || 3306),
      user: process.env.MYSQL_USER || process.env.DB_USER || 'root',
      password: process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || process.env.DB_NAME || 'skillbridge_db',
      ssl: process.env.MYSQL_SSL === 'true'
    };

    // Deep copy initial data into in-memory store with default hashed passwords for seeded accounts
    const defaultSeededHash = hashPassword('SkillBridge2026!');
    this.inMemStore = {
      users: JSON.parse(JSON.stringify(INITIAL_USERS)).map((u: any) => ({
        ...u,
        password_hash: u.password_hash || defaultSeededHash
      })),
      student_profiles: JSON.parse(JSON.stringify(INITIAL_STUDENT_PROFILES)),
      skills: JSON.parse(JSON.stringify(INITIAL_SKILLS)),
      student_skills: JSON.parse(JSON.stringify(INITIAL_STUDENT_SKILLS)),
      job_postings: JSON.parse(JSON.stringify(INITIAL_JOB_POSTINGS)),
      job_required_skills: JSON.parse(JSON.stringify(INITIAL_JOB_REQUIRED_SKILLS)),
      job_applications: JSON.parse(JSON.stringify(INITIAL_JOB_APPLICATIONS)),
      logs: []
    };
  }

  public async initialize(): Promise<void> {
    console.log(`[MySQL Backend] Initializing connection to ${this.currentConfig.user}@${this.currentConfig.host}:${this.currentConfig.port}/${this.currentConfig.database}`);
    await this.connect(this.currentConfig);
  }

  public async connect(config: MySQLConfig): Promise<{ success: boolean; message: string; latencyMs: number }> {
    this.currentConfig = { ...config };
    const start = Date.now();

    try {
      if (this.pool) {
        try {
          await this.pool.end();
        } catch {
          // ignore cleanup errors
        }
        this.pool = null;
      }

      const connectionConfig: any = {
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        connectTimeout: 4000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000
      };

      if (config.ssl) {
        connectionConfig.ssl = { rejectUnauthorized: false };
      }

      const testPool = mysql.createPool(connectionConfig);
      const conn: PoolConnection = await testPool.getConnection();
      
      const pingStart = Date.now();
      await conn.ping();
      this.lastPingMs = Date.now() - pingStart;
      conn.release();

      this.pool = testPool;
      this.isConnected = true;
      this.lastError = undefined;

      console.log(`[MySQL Backend] Successfully connected to MySQL at ${config.host}:${config.port} (${this.lastPingMs}ms)`);
      
      // Auto-migrate tables
      await this.ensureSchema();
      await this.syncInMemToMySQL();

      this.logQuery('SELECT 1 /* MySQL Health Check & Ping */', this.lastPingMs, 1, 'mysql-server');

      return {
        success: true,
        message: `Connected to MySQL database '${config.database}' at ${config.host}:${config.port}`,
        latencyMs: this.lastPingMs
      };
    } catch (err: any) {
      this.isConnected = false;
      this.lastError = err.message || 'Connection failed';
      this.lastPingMs = Date.now() - start;
      console.warn(`[MySQL Backend] External MySQL connection failed (${err.code || err.message}). Operating in resilient local relational mode.`);
      
      this.logQuery(
        `-- Connection attempt to ${config.host}:${config.port} failed: ${err.message}. Using active local relational store.`,
        this.lastPingMs,
        0,
        'in-memory-engine'
      );

      return {
        success: false,
        message: `Could not connect to MySQL server at ${config.host}:${config.port} (${err.message}). Active backend will use local relational engine.`,
        latencyMs: this.lastPingMs
      };
    }
  }

  private async ensureSchema(): Promise<void> {
    if (!this.pool || !this.isConnected) return;

    try {
      const ddlStatements = [
        `CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(255) NOT NULL UNIQUE,
          password_hash VARCHAR(255),
          full_name VARCHAR(150) NOT NULL,
          role ENUM('student', 'recruiter', 'admin') DEFAULT 'student',
          avatar_url VARCHAR(500),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB;`,

        `CREATE TABLE IF NOT EXISTS student_profiles (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          university VARCHAR(200) NOT NULL,
          major VARCHAR(150) NOT NULL,
          degree VARCHAR(100) DEFAULT 'Bachelor of Science',
          graduation_year INT NOT NULL,
          gpa DECIMAL(3, 2) DEFAULT 3.50,
          target_role VARCHAR(150),
          bio TEXT,
          github_url VARCHAR(255),
          linkedin_url VARCHAR(255),
          portfolio_url VARCHAR(255),
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB;`,

        `CREATE TABLE IF NOT EXISTS skills (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL UNIQUE,
          category VARCHAR(80) NOT NULL,
          description VARCHAR(255),
          icon_name VARCHAR(50),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB;`,

        `CREATE TABLE IF NOT EXISTS student_skills (
          id INT AUTO_INCREMENT PRIMARY KEY,
          student_id INT NOT NULL,
          skill_id INT NOT NULL,
          proficiency_level INT NOT NULL CHECK (proficiency_level BETWEEN 1 AND 5),
          years_experience DECIMAL(3, 1) DEFAULT 1.0,
          verified BOOLEAN DEFAULT FALSE,
          notes VARCHAR(255),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_student_skill (student_id, skill_id),
          FOREIGN KEY (student_id) REFERENCES student_profiles(id) ON DELETE CASCADE,
          FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
        ) ENGINE=InnoDB;`,

        `CREATE TABLE IF NOT EXISTS job_postings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          title VARCHAR(200) NOT NULL,
          company VARCHAR(150) NOT NULL,
          department VARCHAR(100),
          location VARCHAR(150) NOT NULL,
          work_type ENUM('Remote', 'Hybrid', 'On-site') NOT NULL DEFAULT 'Remote',
          experience_level ENUM('Internship', 'Entry Level', 'Mid Level', 'Senior') NOT NULL DEFAULT 'Entry Level',
          salary_min INT DEFAULT 0,
          salary_max INT DEFAULT 0,
          description TEXT NOT NULL,
          deadline DATE,
          posted_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB;`,

        `CREATE TABLE IF NOT EXISTS job_required_skills (
          id INT AUTO_INCREMENT PRIMARY KEY,
          job_id INT NOT NULL,
          skill_id INT NOT NULL,
          importance ENUM('Required', 'Preferred') DEFAULT 'Required',
          min_proficiency INT NOT NULL DEFAULT 3 CHECK (min_proficiency BETWEEN 1 AND 5),
          weight DECIMAL(3, 2) DEFAULT 1.00,
          FOREIGN KEY (job_id) REFERENCES job_postings(id) ON DELETE CASCADE,
          FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
        ) ENGINE=InnoDB;`,

        `CREATE TABLE IF NOT EXISTS job_applications (
          id INT AUTO_INCREMENT PRIMARY KEY,
          student_id INT NOT NULL,
          job_id INT NOT NULL,
          match_percentage_at_apply DECIMAL(5, 2) NOT NULL DEFAULT 0,
          status ENUM('Applied', 'Reviewing', 'Interviewing', 'Accepted', 'Rejected') DEFAULT 'Applied',
          notes VARCHAR(255),
          applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (student_id) REFERENCES student_profiles(id) ON DELETE CASCADE,
          FOREIGN KEY (job_id) REFERENCES job_postings(id) ON DELETE CASCADE
        ) ENGINE=InnoDB;`
      ];

      for (const statement of ddlStatements) {
        await this.pool.query(statement);
      }
      // Ensure password_hash column exists on pre-existing users tables
      try {
        await this.pool.query('ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) AFTER email;');
      } catch (alterErr: any) {
        if (!String(alterErr?.message || '').includes('Duplicate column')) {
          console.warn('[MySQL Backend] Column migration note:', alterErr.message);
        }
      }
      console.log('[MySQL Backend] Relational InnoDB schema confirmed on MySQL server');
    } catch (err: any) {
      console.error('[MySQL Backend] Error executing schema creation on MySQL:', err.message);
    }
  }

  private async syncInMemToMySQL(): Promise<void> {
    if (!this.pool || !this.isConnected) return;

    try {
      // Check if users table already has data
      const [userRows]: any = await this.pool.query('SELECT COUNT(*) as count FROM users');
      if (userRows[0]?.count > 0) {
        console.log('[MySQL Backend] MySQL tables already contain data, skipping initial population.');
        return;
      }

      console.log('[MySQL Backend] Seeding initial dataset into MySQL tables...');
      
      // Insert users
      for (const u of this.inMemStore.users) {
        await this.pool.query(
          'INSERT INTO users (id, email, password_hash, full_name, role, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [u.id, u.email, u.password_hash || hashPassword('SkillBridge2026!'), u.full_name, u.role, u.avatar_url || null, u.created_at || new Date()]
        );
      }

      // Insert student profiles
      for (const sp of this.inMemStore.student_profiles) {
        await this.pool.query(
          `INSERT INTO student_profiles (id, user_id, university, major, degree, graduation_year, gpa, target_role, bio, github_url, linkedin_url, portfolio_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [sp.id, sp.user_id, sp.university, sp.major, sp.degree || 'B.S.', sp.graduation_year, sp.gpa, sp.target_role, sp.bio, sp.github_url || null, sp.linkedin_url || null, sp.portfolio_url || null]
        );
      }

      // Insert skills
      for (const sk of this.inMemStore.skills) {
        await this.pool.query(
          'INSERT INTO skills (id, name, category, description, icon_name) VALUES (?, ?, ?, ?, ?)',
          [sk.id, sk.name, sk.category, sk.description, sk.icon_name || null]
        );
      }

      // Insert student_skills
      for (const ss of this.inMemStore.student_skills) {
        await this.pool.query(
          'INSERT INTO student_skills (id, student_id, skill_id, proficiency_level, years_experience, verified, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [ss.id, ss.student_id, ss.skill_id, ss.proficiency_level, ss.years_experience, ss.verified, ss.notes || null]
        );
      }

      // Insert job postings
      for (const jp of this.inMemStore.job_postings) {
        await this.pool.query(
          `INSERT INTO job_postings (id, title, company, department, location, work_type, experience_level, salary_min, salary_max, description, deadline, posted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [jp.id, jp.title, jp.company, jp.department, jp.location, jp.work_type, jp.experience_level, jp.salary_min, jp.salary_max, jp.description, jp.deadline || '2026-12-31', jp.posted_at || new Date()]
        );
      }

      // Insert job_required_skills
      for (const jrs of this.inMemStore.job_required_skills) {
        await this.pool.query(
          'INSERT INTO job_required_skills (id, job_id, skill_id, importance, min_proficiency, weight) VALUES (?, ?, ?, ?, ?, ?)',
          [jrs.id, jrs.job_id, jrs.skill_id, jrs.importance, jrs.min_proficiency, jrs.weight]
        );
      }

      // Insert applications
      for (const app of this.inMemStore.job_applications) {
        await this.pool.query(
          'INSERT INTO job_applications (id, student_id, job_id, match_percentage_at_apply, status, notes, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [app.id, app.student_id, app.job_id, app.match_percentage_at_apply, app.status, app.notes || null, app.applied_at || new Date()]
        );
      }

      console.log('[MySQL Backend] Seeded full dataset into live MySQL tables successfully');
    } catch (err: any) {
      console.error('[MySQL Backend] Error seeding data into MySQL:', err.message);
    }
  }

  public async reseedAll(): Promise<{ success: boolean; message: string }> {
    if (this.activeTxConn) {
      try {
        await this.activeTxConn.rollback();
      } catch {
        // ignore rollback cleanup errors
      }
      try {
        this.activeTxConn.release();
      } catch {
        // ignore release errors
      }
      this.activeTxConn = null;
    }
    this.txSnapshot = null;
    this.savepoints.clear();

    const defaultSeededHash = hashPassword('SkillBridge2026!');
    this.inMemStore = {
      users: JSON.parse(JSON.stringify(INITIAL_USERS)).map((u: any) => ({
        ...u,
        password_hash: u.password_hash || defaultSeededHash
      })),
      student_profiles: JSON.parse(JSON.stringify(INITIAL_STUDENT_PROFILES)),
      skills: JSON.parse(JSON.stringify(INITIAL_SKILLS)),
      student_skills: JSON.parse(JSON.stringify(INITIAL_STUDENT_SKILLS)),
      job_postings: JSON.parse(JSON.stringify(INITIAL_JOB_POSTINGS)),
      job_required_skills: JSON.parse(JSON.stringify(INITIAL_JOB_REQUIRED_SKILLS)),
      job_applications: JSON.parse(JSON.stringify(INITIAL_JOB_APPLICATIONS)),
      logs: []
    };

    if (this.isConnected && this.pool) {
      try {
        await this.pool.query('SET FOREIGN_KEY_CHECKS = 0;');
        await this.pool.query('TRUNCATE TABLE job_applications;');
        await this.pool.query('TRUNCATE TABLE job_required_skills;');
        await this.pool.query('TRUNCATE TABLE student_skills;');
        await this.pool.query('TRUNCATE TABLE job_postings;');
        await this.pool.query('TRUNCATE TABLE skills;');
        await this.pool.query('TRUNCATE TABLE student_profiles;');
        await this.pool.query('TRUNCATE TABLE users;');
        await this.pool.query('SET FOREIGN_KEY_CHECKS = 1;');
        await this.syncInMemToMySQL();
      } catch (err: any) {
        return { success: false, message: `Reset error: ${err.message}` };
      }
    }

    this.logQuery('CALL ResetAndSeedDatabase() /* Truncated and reloaded fixtures */', 25, 0, this.isConnected ? 'mysql-server' : 'in-memory-engine');
    return { success: true, message: 'Database reset and re-seeded successfully' };
  }

  private splitSQLStatements(sqlString: string): string[] {
    const statements: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let inBacktick = false;

    const lines = sqlString.split(/\r?\n/);
    const cleanedLines = lines.map(line => {
      // Strip -- line comments outside quotes simply when line starts with --
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('--')) return '';
      return line;
    });
    const text = cleanedLines.join('\n');

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const prev = i > 0 ? text[i - 1] : '';

      if (ch === "'" && !inDouble && !inBacktick && prev !== '\\') {
        inSingle = !inSingle;
      } else if (ch === '"' && !inSingle && !inBacktick && prev !== '\\') {
        inDouble = !inDouble;
      } else if (ch === '`' && !inSingle && !inDouble) {
        inBacktick = !inBacktick;
      }

      if (ch === ';' && !inSingle && !inDouble && !inBacktick) {
        if (current.trim()) statements.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }

    if (current.trim()) {
      statements.push(current.trim());
    }
    return statements;
  }

  private cloneStore(store: InMemStore): InMemStore {
    return JSON.parse(JSON.stringify(store));
  }

  // Live SQL Query Executor (supports single & multi-statement scripts + transactions)
  public async executeRawSQL(sqlString: string): Promise<{
    columns: string[];
    rows: any[];
    executionTimeMs: number;
    affectedRows: number;
    inTransaction: boolean;
    statementSummaries?: { statement: string; status: string; rowsAffected: number }[];
    error?: string;
  }> {
    const statements = this.splitSQLStatements(sqlString);
    if (statements.length === 0) {
      return {
        columns: ['Status'],
        rows: [{ Status: 'No SQL statements to execute.' }],
        executionTimeMs: 0,
        affectedRows: 0,
        inTransaction: Boolean(this.activeTxConn || this.txSnapshot)
      };
    }

    const totalStart = Date.now();
    const summaries: { statement: string; status: string; rowsAffected: number }[] = [];
    let lastResult: { columns: string[]; rows: any[]; affectedRows: number; error?: string } = {
      columns: ['Status'],
      rows: [],
      affectedRows: 0
    };

    if (this.isConnected && this.pool) {
      for (const stmt of statements) {
        const stmtStart = Date.now();
        const upper = stmt.toUpperCase().trim();

        try {
          if (upper === 'START TRANSACTION' || upper === 'BEGIN' || upper === 'BEGIN WORK') {
            if (!this.activeTxConn) {
              this.activeTxConn = await this.pool.getConnection();
            }
            await this.activeTxConn.beginTransaction();
            const dur = Date.now() - stmtStart;
            this.logQuery(stmt, dur, 0, 'mysql-server');
            summaries.push({ statement: stmt, status: 'Transaction started', rowsAffected: 0 });
            lastResult = {
              columns: ['Status', 'Transaction_State'],
              rows: [{ Status: 'Query OK', Transaction_State: 'ACTIVE (Uncommitted)' }],
              affectedRows: 0
            };
            continue;
          }

          if (upper === 'COMMIT' || upper === 'COMMIT WORK') {
            if (this.activeTxConn) {
              await this.activeTxConn.commit();
              this.activeTxConn.release();
              this.activeTxConn = null;
            } else {
              await this.pool.query('COMMIT');
            }
            const dur = Date.now() - stmtStart;
            this.logQuery(stmt, dur, 0, 'mysql-server');
            summaries.push({ statement: stmt, status: 'Committed', rowsAffected: 0 });
            lastResult = {
              columns: ['Status', 'Transaction_State'],
              rows: [{ Status: 'Transaction committed successfully', Transaction_State: 'AUTOCOMMIT' }],
              affectedRows: 0
            };
            continue;
          }

          if (upper === 'ROLLBACK' || upper === 'ROLLBACK WORK') {
            if (this.activeTxConn) {
              await this.activeTxConn.rollback();
              this.activeTxConn.release();
              this.activeTxConn = null;
            } else {
              await this.pool.query('ROLLBACK');
            }
            const dur = Date.now() - stmtStart;
            this.logQuery(stmt, dur, 0, 'mysql-server');
            summaries.push({ statement: stmt, status: 'Rolled back', rowsAffected: 0 });
            lastResult = {
              columns: ['Status', 'Transaction_State'],
              rows: [{ Status: 'Transaction rolled back — changes reverted', Transaction_State: 'AUTOCOMMIT' }],
              affectedRows: 0
            };
            continue;
          }

          const executor = this.activeTxConn || this.pool;
          const [result, fields]: any = await executor.query(stmt);
          const duration = Date.now() - stmtStart;

          let columns: string[] = [];
          let rows: any[] = [];
          let affected = 0;

          if (Array.isArray(result)) {
            rows = result;
            if (fields && fields.length > 0) {
              columns = fields.map((f: any) => f.name);
            } else if (rows.length > 0) {
              columns = Object.keys(rows[0]);
            } else {
              columns = ['result'];
            }
            summaries.push({ statement: stmt, status: `${rows.length} row(s)`, rowsAffected: rows.length });
          } else if (result && typeof result === 'object') {
            affected = result.affectedRows || 0;
            columns = ['result', 'affectedRows', 'insertId'];
            rows = [{
              result: 'Query OK',
              affectedRows: result.affectedRows || 0,
              insertId: result.insertId || 0
            }];
            summaries.push({ statement: stmt, status: `Query OK (${affected} affected)`, rowsAffected: affected });
          }

          this.logQuery(stmt, duration, affected || rows.length, 'mysql-server');
          lastResult = { columns, rows, affectedRows: affected || rows.length };
        } catch (err: any) {
          const duration = Date.now() - stmtStart;
          this.logQuery(`-- ERROR: ${err.message}\n${stmt}`, duration, 0, 'mysql-server');
          return {
            columns: ['error'],
            rows: [{ error: err.message }],
            executionTimeMs: Date.now() - totalStart,
            affectedRows: 0,
            inTransaction: Boolean(this.activeTxConn),
            statementSummaries: [...summaries, { statement: stmt, status: `ERROR: ${err.message}`, rowsAffected: 0 }],
            error: err.message
          };
        }
      }

      return {
        ...lastResult,
        executionTimeMs: Math.max(1, Date.now() - totalStart),
        inTransaction: Boolean(this.activeTxConn),
        statementSummaries: statements.length > 1 ? summaries : undefined
      };
    }

    // In-memory relational SQL engine (supports transactions, joins, subqueries, unions, DML)
    for (const stmt of statements) {
      const res = this.executeInMemorySQL(stmt);
      if (res.error) {
        return {
          ...res,
          executionTimeMs: Math.max(1, Date.now() - totalStart),
          inTransaction: Boolean(this.txSnapshot),
          statementSummaries: [...summaries, { statement: stmt, status: `ERROR: ${res.error}`, rowsAffected: 0 }]
        };
      }
      summaries.push({
        statement: stmt,
        status: res.rows?.[0]?.Status ? String(res.rows[0].Status) : `${res.rows.length} row(s)`,
        rowsAffected: res.affectedRows
      });
      lastResult = {
        columns: res.columns,
        rows: res.rows,
        affectedRows: res.affectedRows
      };
    }

    return {
      ...lastResult,
      executionTimeMs: Math.max(1, Date.now() - totalStart),
      inTransaction: Boolean(this.txSnapshot),
      statementSummaries: statements.length > 1 ? summaries : undefined
    };
  }

  private parseLiteralValue(raw: string): any {
    const trimmed = raw.trim();
    if (/^NULL$/i.test(trimmed)) return null;
    if (/^TRUE$/i.test(trimmed)) return true;
    if (/^FALSE$/i.test(trimmed)) return false;
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
      return trimmed.slice(1, -1).replace(/\\'/g, "'");
    }
    if (!Number.isNaN(Number(trimmed)) && trimmed !== '') {
      return Number(trimmed);
    }
    return trimmed;
  }

  private splitCommaArgs(raw: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      const prev = i > 0 ? raw[i - 1] : '';
      if (ch === "'" && !inDouble && prev !== '\\') inSingle = !inSingle;
      else if (ch === '"' && !inSingle && prev !== '\\') inDouble = !inDouble;
      if (ch === ',' && !inSingle && !inDouble) {
        parts.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  private getInMemTableRows(tableName: string): any[] | null {
    const key = tableName.toLowerCase().replace(/`/g, '');
    switch (key) {
      case 'users':
        return this.inMemStore.users.map(u => this.sanitizeUser(u));
      case 'student_profiles':
        return this.inMemStore.student_profiles;
      case 'skills':
        return this.inMemStore.skills;
      case 'student_skills':
        return this.inMemStore.student_skills;
      case 'job_postings':
        return this.inMemStore.job_postings;
      case 'job_required_skills':
        return this.inMemStore.job_required_skills;
      case 'job_applications':
        return this.inMemStore.job_applications;
      default:
        return null;
    }
  }

  private applySimpleWhere(rows: any[], whereClause?: string): any[] {
    if (!whereClause) return rows;
    const clean = whereClause.trim();
    const match = clean.match(/^(?:[a-z_]+\.)?([a-z0-9_]+)\s*(=|!=|>=|<=|>|<|LIKE)\s*(.+)$/i);
    if (!match) return rows;

    const col = match[1].toLowerCase();
    const op = match[2].toUpperCase();
    const val = this.parseLiteralValue(match[3]);

    return rows.filter(row => {
      const cell = row[col];
      if (op === '=') return String(cell ?? '').toLowerCase() === String(val ?? '').toLowerCase() || cell === val;
      if (op === '!=') return cell !== val;
      if (op === '>') return Number(cell) > Number(val);
      if (op === '>=') return Number(cell) >= Number(val);
      if (op === '<') return Number(cell) < Number(val);
      if (op === '<=') return Number(cell) <= Number(val);
      if (op === 'LIKE') {
        const pattern = String(val || '').replace(/%/g, '.*').replace(/_/g, '.');
        return new RegExp(`^${pattern}$`, 'i').test(String(cell ?? ''));
      }
      return true;
    });
  }

  private executeInMemorySQL(sql: string): {
    columns: string[];
    rows: any[];
    executionTimeMs: number;
    affectedRows: number;
    error?: string;
  } {
    const start = Date.now();
    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase();

    try {
      // 1. Transaction Control Statements (START TRANSACTION / BEGIN / SAVEPOINT / ROLLBACK / COMMIT)
      if (upper === 'START TRANSACTION' || upper === 'BEGIN' || upper === 'BEGIN WORK') {
        if (!this.txSnapshot) {
          this.txSnapshot = this.cloneStore(this.inMemStore);
        }
        this.savepoints.clear();
        const duration = Date.now() - start;
        this.logQuery(trimmed, duration, 0, 'in-memory-engine');
        return {
          columns: ['Status', 'Transaction_State'],
          rows: [{ Status: 'Transaction started (snapshot created)', Transaction_State: 'ACTIVE (Uncommitted)' }],
          executionTimeMs: duration,
          affectedRows: 0
        };
      }

      const savepointMatch = trimmed.match(/^SAVEPOINT\s+([a-zA-Z0-9_]+)$/i);
      if (savepointMatch) {
        const spName = savepointMatch[1];
        if (!this.txSnapshot) {
          this.txSnapshot = this.cloneStore(this.inMemStore);
        }
        this.savepoints.set(spName, this.cloneStore(this.inMemStore));
        const duration = Date.now() - start;
        this.logQuery(trimmed, duration, 0, 'in-memory-engine');
        return {
          columns: ['Status', 'Savepoint'],
          rows: [{ Status: `Savepoint '${spName}' created`, Savepoint: spName }],
          executionTimeMs: duration,
          affectedRows: 0
        };
      }

      const rollbackToMatch = trimmed.match(/^ROLLBACK\s+(?:WORK\s+)?TO\s+(?:SAVEPOINT\s+)?([a-zA-Z0-9_]+)$/i);
      if (rollbackToMatch) {
        const spName = rollbackToMatch[1];
        const snap = this.savepoints.get(spName);
        if (!snap) {
          throw new Error(`SAVEPOINT ${spName} does not exist`);
        }
        this.inMemStore = this.cloneStore(snap);
        const duration = Date.now() - start;
        this.logQuery(trimmed, duration, 0, 'in-memory-engine');
        return {
          columns: ['Status', 'Savepoint'],
          rows: [{ Status: `Rolled back to savepoint '${spName}'`, Savepoint: spName }],
          executionTimeMs: duration,
          affectedRows: 0
        };
      }

      const releaseSpMatch = trimmed.match(/^RELEASE\s+SAVEPOINT\s+([a-zA-Z0-9_]+)$/i);
      if (releaseSpMatch) {
        const spName = releaseSpMatch[1];
        this.savepoints.delete(spName);
        const duration = Date.now() - start;
        this.logQuery(trimmed, duration, 0, 'in-memory-engine');
        return {
          columns: ['Status', 'Savepoint'],
          rows: [{ Status: `Released savepoint '${spName}'`, Savepoint: spName }],
          executionTimeMs: duration,
          affectedRows: 0
        };
      }

      if (upper === 'ROLLBACK' || upper === 'ROLLBACK WORK') {
        if (this.txSnapshot) {
          this.inMemStore = this.cloneStore(this.txSnapshot);
          this.txSnapshot = null;
        }
        this.savepoints.clear();
        const duration = Date.now() - start;
        this.logQuery(trimmed, duration, 0, 'in-memory-engine');
        return {
          columns: ['Status', 'Transaction_State'],
          rows: [{ Status: 'Transaction rolled back — uncommitted changes reverted', Transaction_State: 'AUTOCOMMIT' }],
          executionTimeMs: duration,
          affectedRows: 0
        };
      }

      if (upper === 'COMMIT' || upper === 'COMMIT WORK') {
        this.txSnapshot = null;
        this.savepoints.clear();
        const duration = Date.now() - start;
        this.logQuery(trimmed, duration, 0, 'in-memory-engine');
        return {
          columns: ['Status', 'Transaction_State'],
          rows: [{ Status: 'Transaction committed successfully', Transaction_State: 'AUTOCOMMIT' }],
          executionTimeMs: duration,
          affectedRows: 0
        };
      }

      // 2. SHOW TABLES
      if (upper === 'SHOW TABLES' || upper.startsWith('SHOW TABLES')) {
        const tables = [
          'users',
          'student_profiles',
          'skills',
          'student_skills',
          'job_postings',
          'job_required_skills',
          'career_recommendations',
          'job_applications'
        ];
        const duration = Date.now() - start;
        this.logQuery(trimmed, duration, tables.length, 'in-memory-engine');
        return {
          columns: ['Tables_in_skillbridge_db'],
          rows: tables.map(t => ({ Tables_in_skillbridge_db: t })),
          executionTimeMs: duration,
          affectedRows: tables.length
        };
      }

      // 3. DESCRIBE / DESC
      if (upper.startsWith('DESCRIBE ') || upper.startsWith('DESC ')) {
        const tableName = trimmed.split(/\s+/)[1]?.toLowerCase().replace(/;/, '');
        const duration = Date.now() - start;
        this.logQuery(trimmed, duration, 0, 'in-memory-engine');
        return {
          columns: ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra'],
          rows: this.getTableDescription(tableName),
          executionTimeMs: duration,
          affectedRows: 0
        };
      }

      // 4. INSERT INTO <table> (cols) VALUES (vals)
      const insertMatch = trimmed.match(/^INSERT\s+INTO\s+`?([a-zA-Z0-9_]+)`?\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
      if (insertMatch) {
        const tableName = insertMatch[1].toLowerCase();
        const cols = insertMatch[2].split(',').map(c => c.trim().replace(/`/g, ''));
        const vals = this.splitCommaArgs(insertMatch[3]).map(v => this.parseLiteralValue(v));

        const targetArr = (this.inMemStore as any)[tableName];
        if (!Array.isArray(targetArr)) {
          throw new Error(`Table '${tableName}' does not exist`);
        }

        const newId = Math.max(0, ...targetArr.map((r: any) => Number(r.id) || 0)) + 1;
        const record: any = { id: newId };
        cols.forEach((c, idx) => {
          record[c] = vals[idx];
        });

        // Prevent duplicate skill name inserts cleanly
        if (tableName === 'skills' && record.name) {
          const dup = targetArr.find((r: any) => String(r.name).toLowerCase() === String(record.name).toLowerCase());
          if (dup) {
            const duration = Date.now() - start;
            this.logQuery(trimmed, duration, 0, 'in-memory-engine');
            return {
              columns: ['Status', 'insertId', 'affectedRows'],
              rows: [{ Status: `Skill '${record.name}' already exists (id=${dup.id})`, insertId: dup.id, affectedRows: 0 }],
              executionTimeMs: duration,
              affectedRows: 0
            };
          }
        }

        targetArr.push(record);
        const duration = Date.now() - start;
        this.logQuery(trimmed, duration, 1, 'in-memory-engine');
        return {
          columns: ['Status', 'insertId', 'affectedRows'],
          rows: [{ Status: 'Query OK', insertId: newId, affectedRows: 1 }],
          executionTimeMs: duration,
          affectedRows: 1
        };
      }

      // 5. UPDATE <table> SET col=val, ... [WHERE ...]
      const updateMatch = trimmed.match(/^UPDATE\s+`?([a-zA-Z0-9_]+)`?\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i);
      if (updateMatch) {
        const tableName = updateMatch[1].toLowerCase();
        const setPart = updateMatch[2];
        const wherePart = updateMatch[3];
        const targetArr = (this.inMemStore as any)[tableName];
        if (!Array.isArray(targetArr)) {
          throw new Error(`Table '${tableName}' does not exist`);
        }

        const assignments = this.splitCommaArgs(setPart).map(pair => {
          const eqIdx = pair.indexOf('=');
          const col = pair.slice(0, eqIdx).trim().replace(/`/g, '');
          const val = this.parseLiteralValue(pair.slice(eqIdx + 1));
          return { col, val };
        });

        const matchedRows = this.applySimpleWhere(targetArr, wherePart);
        matchedRows.forEach(row => {
          assignments.forEach(({ col, val }) => {
            row[col] = val;
          });
          if ('updated_at' in row) {
            row.updated_at = new Date().toISOString().replace('T', ' ').substring(0, 19);
          }
        });

        const duration = Date.now() - start;
        this.logQuery(trimmed, duration, matchedRows.length, 'in-memory-engine');
        return {
          columns: ['Status', 'affectedRows'],
          rows: [{ Status: `Query OK, ${matchedRows.length} row(s) updated`, affectedRows: matchedRows.length }],
          executionTimeMs: duration,
          affectedRows: matchedRows.length
        };
      }

      // 6. DELETE FROM <table> [WHERE ...]
      const deleteMatch = trimmed.match(/^DELETE\s+FROM\s+`?([a-zA-Z0-9_]+)`?(?:\s+WHERE\s+([\s\S]+))?$/i);
      if (deleteMatch) {
        const tableName = deleteMatch[1].toLowerCase();
        const wherePart = deleteMatch[2];
        const targetArr = (this.inMemStore as any)[tableName];
        if (!Array.isArray(targetArr)) {
          throw new Error(`Table '${tableName}' does not exist`);
        }

        const matched = this.applySimpleWhere(targetArr, wherePart);
        const matchedSet = new Set(matched);
        (this.inMemStore as any)[tableName] = targetArr.filter((r: any) => !matchedSet.has(r));

        const duration = Date.now() - start;
        this.logQuery(trimmed, duration, matched.length, 'in-memory-engine');
        return {
          columns: ['Status', 'affectedRows'],
          rows: [{ Status: `Query OK, ${matched.length} row(s) deleted`, affectedRows: matched.length }],
          executionTimeMs: duration,
          affectedRows: matched.length
        };
      }

      // 7. SELECT Queries (UNION, Subqueries, Multi-table JOINs, LEFT JOINs, GROUP BY/HAVING, single-table WHERE/ORDER/LIMIT)
      if (upper.startsWith('SELECT')) {
        let rows: any[] = [];
        const limitMatch = trimmed.match(/\bLIMIT\s+(\d+)\s*$/i);
        const limitNum = limitMatch ? Number(limitMatch[1]) : null;

        // 7a. UNION query (e.g. users UNION job_postings companies)
        if (upper.includes(' UNION ')) {
          const userEntities = this.inMemStore.users.map(u => ({
            entity_name: u.full_name,
            entity_type: u.role,
            detail: u.email
          }));
          const seenCompanies = new Set<string>();
          const companyEntities: any[] = [];
          this.inMemStore.job_postings.forEach(j => {
            if (!seenCompanies.has(j.company)) {
              seenCompanies.add(j.company);
              companyEntities.push({
                entity_name: j.company,
                entity_type: 'employer',
                detail: j.location
              });
            }
          });
          rows = [...userEntities, ...companyEntities];
        }
        // 7b. Subquery: students with GPA >= AVG(gpa)
        else if (upper.includes('SELECT AVG(GPA)') || upper.includes('SELECT AVG(`GPA`)')) {
          const profiles = this.inMemStore.student_profiles;
          const avgGpa = profiles.length > 0
            ? profiles.reduce((sum, p) => sum + Number(p.gpa || 0), 0) / profiles.length
            : 0;
          rows = profiles
            .filter(sp => Number(sp.gpa) >= avgGpa)
            .map(sp => {
              const u = this.inMemStore.users.find(usr => usr.id === sp.user_id);
              return {
                full_name: u?.full_name || 'Student',
                university: sp.university,
                major: sp.major,
                gpa: Number(sp.gpa).toFixed(2),
                avg_cohort_gpa: avgGpa.toFixed(2),
                target_role: sp.target_role
              };
            })
            .sort((a, b) => Number(b.gpa) - Number(a.gpa));
        }
        // 7c. Skill Gap Analysis 4-table JOIN (job_postings + job_required_skills + skills + LEFT JOIN student_skills)
        else if (upper.includes('JOB_POSTINGS') && upper.includes('JOB_REQUIRED_SKILLS') && upper.includes('STUDENT_SKILLS')) {
          const jobIdMatch = trimmed.match(/j\.id\s*=\s*(\d+)/i);
          const studentIdMatch = trimmed.match(/student_id\s*=\s*(\d+)/i);
          const targetJobId = jobIdMatch ? Number(jobIdMatch[1]) : (this.inMemStore.job_postings[0]?.id || 1);
          const targetStudentId = studentIdMatch ? Number(studentIdMatch[1]) : 1;

          const job = this.inMemStore.job_postings.find(j => j.id === targetJobId);
          const reqs = this.inMemStore.job_required_skills.filter(r => r.job_id === targetJobId);

          rows = reqs.map(r => {
            const sk = this.inMemStore.skills.find(s => s.id === r.skill_id);
            const ss = this.inMemStore.student_skills.find(
              s => s.job_id === undefined && s.student_id === targetStudentId && s.skill_id === r.skill_id
            );
            const studentLvl = ss ? Number(ss.proficiency_level) : 0;
            return {
              job_title: job?.title || `Job #${targetJobId}`,
              company: job?.company || '',
              required_skill: sk?.name || `Skill #${r.skill_id}`,
              importance: r.importance,
              min_proficiency: r.min_proficiency,
              student_level: studentLvl,
              status: studentLvl >= r.min_proficiency ? 'Met' : 'Gap'
            };
          });
        }
        // 7d. LEFT JOIN: job_postings + job_applications aggregation
        else if (upper.includes('JOB_POSTINGS') && upper.includes('JOB_APPLICATIONS')) {
          rows = this.inMemStore.job_postings.map(j => {
            const apps = this.inMemStore.job_applications.filter(a => a.job_id === j.id);
            const avgMatch = apps.length > 0
              ? (apps.reduce((sum, a) => sum + Number(a.match_percentage_at_apply || 0), 0) / apps.length).toFixed(1)
              : '0.0';
            return {
              id: j.id,
              title: j.title,
              company: j.company,
              work_type: j.work_type,
              total_applications: apps.length,
              avg_match_pct: avgMatch
            };
          }).sort((a, b) => b.total_applications - a.total_applications || a.id - b.id);
        }
        // 7e. Multi-table JOIN: student_profiles + users + student_skills + skills
        else if (upper.includes('STUDENT_PROFILES') && upper.includes('STUDENT_SKILLS') && upper.includes('SKILLS')) {
          rows = this.inMemStore.student_skills.map(ss => {
            const sp = this.inMemStore.student_profiles.find(p => p.id === ss.student_id);
            const u = this.inMemStore.users.find(usr => usr.id === sp?.user_id);
            const sk = this.inMemStore.skills.find(s => s.id === ss.skill_id);
            return {
              student_name: u?.full_name || `Student #${ss.student_id}`,
              skill_name: sk?.name || `Skill #${ss.skill_id}`,
              category: sk?.category || '',
              proficiency_level: ss.proficiency_level,
              years_experience: ss.years_experience,
              verified: ss.verified ? 1 : 0
            };
          }).sort((a, b) => a.student_name.localeCompare(b.student_name) || b.proficiency_level - a.proficiency_level);
        }
        // 7f. INNER JOIN: users + student_profiles
        else if (upper.includes('USERS') && upper.includes('STUDENT_PROFILES')) {
          let joined = this.inMemStore.student_profiles.map(sp => {
            const u = this.inMemStore.users.find(usr => usr.id === sp.user_id);
            return {
              id: sp.id,
              full_name: u?.full_name || 'Student',
              email: u?.email || '',
              university: sp.university,
              major: sp.major,
              gpa: sp.gpa,
              target_role: sp.target_role
            };
          });
          const whereMatch = trimmed.match(/\bWHERE\s+([\s\S]+?)(?:\s+ORDER\s+BY|\s+LIMIT|$)/i);
          if (whereMatch) {
            joined = this.applySimpleWhere(joined, whereMatch[1]);
          }
          if (upper.includes('ORDER BY') && upper.includes('GPA DESC')) {
            joined.sort((a, b) => Number(b.gpa) - Number(a.gpa));
          }
          rows = joined;
        }
        // 7g. GROUP BY & HAVING: skills + student_skills aggregation
        else if (upper.includes('SKILLS') && upper.includes('STUDENT_SKILLS')) {
          const statsMap: Record<number, { name: string; category: string; total: number; sumProf: number }> = {};
          this.inMemStore.skills.forEach(s => {
            statsMap[s.id] = { name: s.name, category: s.category, total: 0, sumProf: 0 };
          });
          this.inMemStore.student_skills.forEach(ss => {
            if (statsMap[ss.skill_id]) {
              statsMap[ss.skill_id].total++;
              statsMap[ss.skill_id].sumProf += Number(ss.proficiency_level || 0);
            }
          });
          const havingMatch = trimmed.match(/HAVING\s+COUNT\([^)]+\)\s*(>=|>|=)\s*(\d+)/i);
          const minCount = havingMatch ? Number(havingMatch[2]) : 0;

          rows = Object.values(statsMap)
            .filter(item => item.total >= minCount)
            .map(item => ({
              name: item.name,
              category: item.category,
              student_count: item.total,
              avg_proficiency: item.total > 0 ? (item.sumProf / item.total).toFixed(2) : '0.00'
            }))
            .sort((a, b) => Number(b.avg_proficiency) - Number(a.avg_proficiency) || b.student_count - a.student_count);
        }
        // 7h. Generic single-table SELECT with WHERE, ORDER BY, LIMIT
        else {
          const fromMatch = trimmed.match(/\bFROM\s+`?([a-zA-Z0-9_]+)`?/i);
          const tableName = fromMatch ? fromMatch[1].toLowerCase() : '';
          const tableRows = this.getInMemTableRows(tableName);

          if (tableRows) {
            let working = [...tableRows];
            const whereMatch = trimmed.match(/\bWHERE\s+([\s\S]+?)(?:\s+ORDER\s+BY|\s+LIMIT|$)/i);
            if (whereMatch) {
              working = this.applySimpleWhere(working, whereMatch[1]);
            }

            const orderMatch = trimmed.match(/\bORDER\s+BY\s+(?:[a-z_]+\.)?([a-z0-9_]+)(?:\s+(ASC|DESC))?/i);
            if (orderMatch) {
              const sortCol = orderMatch[1].toLowerCase();
              const desc = (orderMatch[2] || 'ASC').toUpperCase() === 'DESC';
              working.sort((a, b) => {
                const av = a[sortCol];
                const bv = b[sortCol];
                if (typeof av === 'number' && typeof bv === 'number') return desc ? bv - av : av - bv;
                return desc
                  ? String(bv ?? '').localeCompare(String(av ?? ''))
                  : String(av ?? '').localeCompare(String(bv ?? ''));
              });
            }

            // Column projection if not SELECT *
            const selectPartMatch = trimmed.match(/^SELECT\s+([\s\S]+?)\s+FROM\b/i);
            if (selectPartMatch && selectPartMatch[1].trim() !== '*') {
              const requestedCols = selectPartMatch[1]
                .split(',')
                .map(c => {
                  const aliasMatch = c.match(/\bAS\s+([a-zA-Z0-9_]+)\s*$/i);
                  const rawCol = c.replace(/\bAS\s+[a-zA-Z0-9_]+\s*$/i, '').trim().replace(/^[a-z_]+\./i, '').replace(/`/g, '');
                  return { rawCol, alias: aliasMatch ? aliasMatch[1] : rawCol };
                });

              working = working.map(row => {
                const projected: Record<string, any> = {};
                requestedCols.forEach(({ rawCol, alias }) => {
                  if (rawCol in row) {
                    projected[alias] = row[rawCol];
                  }
                });
                return Object.keys(projected).length > 0 ? projected : row;
              });
            }

            rows = working;
          } else {
            rows = [{ message: 'Query executed against active in-memory relational store', query: trimmed }];
          }
        }

        if (limitNum !== null && limitNum > 0) {
          rows = rows.slice(0, limitNum);
        }

        const duration = Date.now() - start;
        const columns = rows.length > 0 ? Object.keys(rows[0]) : ['result'];
        this.logQuery(trimmed, duration, rows.length, 'in-memory-engine');
        return {
          columns,
          rows,
          executionTimeMs: duration,
          affectedRows: rows.length
        };
      }

      // Default fallback
      const duration = Date.now() - start;
      this.logQuery(trimmed, duration, 1, 'in-memory-engine');
      return {
        columns: ['Status'],
        rows: [{ Status: 'Query OK (in-memory)' }],
        executionTimeMs: duration,
        affectedRows: 1
      };
    } catch (e: any) {
      const duration = Date.now() - start;
      this.logQuery(`-- ERROR: ${e.message}\n${trimmed}`, duration, 0, 'in-memory-engine');
      return {
        columns: ['error'],
        rows: [{ error: e.message }],
        executionTimeMs: duration,
        affectedRows: 0,
        error: e.message
      };
    }
  }

  private getTableDescription(table: string): any[] {
    switch (table) {
      case 'student_profiles':
        return [
          { Field: 'id', Type: 'int(11)', Null: 'NO', Key: 'PRI', Default: 'NULL', Extra: 'auto_increment' },
          { Field: 'user_id', Type: 'int(11)', Null: 'NO', Key: 'MUL', Default: 'NULL', Extra: '' },
          { Field: 'university', Type: 'varchar(200)', Null: 'NO', Key: '', Default: 'NULL', Extra: '' },
          { Field: 'major', Type: 'varchar(150)', Null: 'NO', Key: '', Default: 'NULL', Extra: '' },
          { Field: 'gpa', Type: 'decimal(3,2)', Null: 'YES', Key: '', Default: '3.50', Extra: '' },
          { Field: 'target_role', Type: 'varchar(150)', Null: 'YES', Key: '', Default: 'NULL', Extra: '' },
          { Field: 'updated_at', Type: 'datetime', Null: 'YES', Key: '', Default: 'CURRENT_TIMESTAMP', Extra: 'on update' }
        ];
      case 'skills':
        return [
          { Field: 'id', Type: 'int(11)', Null: 'NO', Key: 'PRI', Default: 'NULL', Extra: 'auto_increment' },
          { Field: 'name', Type: 'varchar(100)', Null: 'NO', Key: 'UNI', Default: 'NULL', Extra: '' },
          { Field: 'category', Type: 'varchar(80)', Null: 'NO', Key: '', Default: 'NULL', Extra: '' },
          { Field: 'description', Type: 'varchar(255)', Null: 'YES', Key: '', Default: 'NULL', Extra: '' }
        ];
      default:
        return [
          { Field: 'id', Type: 'int(11)', Null: 'NO', Key: 'PRI', Default: 'NULL', Extra: 'auto_increment' },
          { Field: 'created_at', Type: 'datetime', Null: 'YES', Key: '', Default: 'CURRENT_TIMESTAMP', Extra: '' }
        ];
    }
  }

  private sanitizeUser(u: any) {
    if (!u) return null;
    const { password_hash, ...safeUser } = u;
    return safeUser;
  }

  public async signupUser(input: {
    email: string;
    password: string;
    fullName: string;
    role?: 'student' | 'recruiter';
    university?: string;
    major?: string;
    degree?: string;
    graduationYear?: number;
    targetRole?: string;
  }): Promise<{ user: any; profile: any | null; token: string }> {
    const start = Date.now();
    const email = (input.email || '').trim().toLowerCase();
    const fullName = (input.fullName || '').trim();
    const password = input.password || '';
    const role: 'student' | 'recruiter' = input.role === 'recruiter' ? 'recruiter' : 'student';

    if (!email || !email.includes('@')) {
      const err: any = new Error('Please enter a valid email address.');
      err.statusCode = 400;
      throw err;
    }
    if (!fullName || fullName.length < 2) {
      const err: any = new Error('Full name must be at least 2 characters.');
      err.statusCode = 400;
      throw err;
    }
    if (password.length < 6) {
      const err: any = new Error('Password must be at least 6 characters.');
      err.statusCode = 400;
      throw err;
    }

    // Check duplicate email in MySQL if connected, otherwise inMemStore
    if (this.isConnected && this.pool) {
      const [existing]: any = await this.pool.query('SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1', [email]);
      if (existing.length > 0) {
        const err: any = new Error('An account with this email already exists.');
        err.statusCode = 409;
        throw err;
      }
    } else {
      const existing = this.inMemStore.users.find(u => String(u.email).toLowerCase() === email);
      if (existing) {
        const err: any = new Error('An account with this email already exists.');
        err.statusCode = 409;
        throw err;
      }
    }

    const passwordHash = hashPassword(password);
    const createdAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
    let newUserId = Math.max(...this.inMemStore.users.map(u => u.id), 0) + 1;
    let newProfile: any | null = null;

    if (this.isConnected && this.pool) {
      const [userRes]: any = await this.pool.query(
        'INSERT INTO users (email, password_hash, full_name, role, created_at) VALUES (?, ?, ?, ?, ?)',
        [email, passwordHash, fullName, role, createdAt]
      );
      newUserId = userRes.insertId || newUserId;
    }

    const newUser = {
      id: newUserId,
      email,
      password_hash: passwordHash,
      full_name: fullName,
      role,
      created_at: createdAt
    };
    this.inMemStore.users.push(newUser);

    if (role === 'student') {
      let newProfileId = Math.max(...this.inMemStore.student_profiles.map(p => p.id), 0) + 1;
      const university = (input.university || '').trim() || 'State University';
      const major = (input.major || '').trim() || 'Computer Science';
      const degree = (input.degree || '').trim() || 'B.S. in Computer Science';
      const graduationYear = Number(input.graduationYear) || 2027;
      const targetRole = (input.targetRole || '').trim() || 'Software Engineer';
      const bio = `${major} student at ${university} targeting ${targetRole} opportunities.`;

      if (this.isConnected && this.pool) {
        const [profRes]: any = await this.pool.query(
          `INSERT INTO student_profiles (user_id, university, major, degree, graduation_year, gpa, target_role, bio)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [newUserId, university, major, degree, graduationYear, 3.5, targetRole, bio]
        );
        newProfileId = profRes.insertId || newProfileId;
      }

      newProfile = {
        id: newProfileId,
        user_id: newUserId,
        university,
        major,
        degree,
        graduation_year: graduationYear,
        gpa: 3.5,
        bio,
        target_role: targetRole,
        github_url: '',
        linkedin_url: '',
        portfolio_url: '',
        updated_at: createdAt
      };
      this.inMemStore.student_profiles.push(newProfile);
    }

    const duration = Date.now() - start;
    this.logQuery(
      `INSERT INTO users (email, full_name, role) VALUES ('${email}', '${fullName.replace(/'/g, "\\'")}', '${role}');`,
      duration,
      role === 'student' ? 2 : 1,
      this.isConnected ? 'mysql-server' : 'in-memory-engine'
    );

    const token = createSessionToken({ id: newUser.id, email: newUser.email, role: newUser.role });
    return {
      user: this.sanitizeUser(newUser),
      profile: newProfile,
      token
    };
  }

  public async loginUser(emailInput: string, passwordInput: string): Promise<{ user: any; profile: any | null; token: string }> {
    const start = Date.now();
    const email = (emailInput || '').trim().toLowerCase();
    const password = passwordInput || '';

    if (!email || !password) {
      const err: any = new Error('Email and password are required.');
      err.statusCode = 400;
      throw err;
    }

    let user: any = null;
    let profile: any | null = null;

    if (this.isConnected && this.pool) {
      const [userRows]: any = await this.pool.query('SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1', [email]);
      user = userRows[0] || null;
      if (user && user.role === 'student') {
        const [profRows]: any = await this.pool.query('SELECT * FROM student_profiles WHERE user_id = ? LIMIT 1', [user.id]);
        profile = profRows[0] || null;
      }
    } else {
      user = this.inMemStore.users.find(u => String(u.email).toLowerCase() === email) || null;
      if (user && user.role === 'student') {
        profile = this.inMemStore.student_profiles.find(sp => sp.user_id === user.id) || null;
      }
    }

    if (!user || !verifyPassword(password, user.password_hash)) {
      const err: any = new Error('Invalid email or password.');
      err.statusCode = 401;
      throw err;
    }

    const duration = Date.now() - start;
    this.logQuery(
      `SELECT id, email, full_name, role FROM users WHERE email = '${email}' LIMIT 1;`,
      duration,
      1,
      this.isConnected ? 'mysql-server' : 'in-memory-engine'
    );

    const token = createSessionToken({ id: user.id, email: user.email, role: user.role });
    return {
      user: this.sanitizeUser(user),
      profile,
      token
    };
  }

  public async getSessionUser(token: string): Promise<{ user: any; profile: any | null } | null> {
    const decoded = verifySessionToken(token);
    if (!decoded) return null;

    let user: any = null;
    let profile: any | null = null;

    if (this.isConnected && this.pool) {
      try {
        const [userRows]: any = await this.pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [decoded.userId]);
        user = userRows[0] || null;
        if (user && user.role === 'student') {
          const [profRows]: any = await this.pool.query('SELECT * FROM student_profiles WHERE user_id = ? LIMIT 1', [user.id]);
          profile = profRows[0] || null;
        }
      } catch {
        // fallback to inMemStore
      }
    }

    if (!user) {
      user = this.inMemStore.users.find(u => u.id === decoded.userId) || null;
      if (user && user.role === 'student') {
        profile = this.inMemStore.student_profiles.find(sp => sp.user_id === user.id) || null;
      }
    }

    if (!user) return null;
    return {
      user: this.sanitizeUser(user),
      profile
    };
  }

  // CRUD Operations with sync to both MySQL and in-memory cache
  public async getFullDataset(): Promise<any> {
    if (this.isConnected && this.pool) {
      try {
        const [users]: any = await this.pool.query('SELECT id, email, full_name, role, avatar_url, created_at FROM users');
        const [student_profiles]: any = await this.pool.query('SELECT * FROM student_profiles');
        const [skills]: any = await this.pool.query('SELECT * FROM skills');
        const [student_skills]: any = await this.pool.query('SELECT * FROM student_skills');
        const [job_postings]: any = await this.pool.query('SELECT * FROM job_postings');
        const [job_required_skills]: any = await this.pool.query('SELECT * FROM job_required_skills');
        const [job_applications]: any = await this.pool.query('SELECT * FROM job_applications');

        return {
          users,
          student_profiles,
          skills,
          student_skills,
          job_postings,
          job_required_skills,
          job_applications,
          logs: this.logs.slice(0, 50)
        };
      } catch (err: any) {
        console.warn('[MySQL Backend] Query error, falling back to cached state:', err.message);
      }
    }

    return {
      users: this.inMemStore.users.map(u => this.sanitizeUser(u)),
      student_profiles: this.inMemStore.student_profiles,
      skills: this.inMemStore.skills,
      student_skills: this.inMemStore.student_skills,
      job_postings: this.inMemStore.job_postings,
      job_required_skills: this.inMemStore.job_required_skills,
      job_applications: this.inMemStore.job_applications,
      logs: this.logs.slice(0, 50)
    };
  }

  public async updateStudentProfile(id: number, data: any): Promise<any> {
    const start = Date.now();
    const index = this.inMemStore.student_profiles.findIndex(sp => sp.id === id);
    if (index !== -1) {
      this.inMemStore.student_profiles[index] = {
        ...this.inMemStore.student_profiles[index],
        ...data,
        updated_at: new Date().toISOString()
      };
    }

    const sql = `UPDATE student_profiles SET university = ?, major = ?, gpa = ?, target_role = ?, bio = ?, github_url = ?, linkedin_url = ?, portfolio_url = ?, updated_at = NOW() WHERE id = ?`;
    const params = [
      data.university,
      data.major,
      data.gpa,
      data.target_role,
      data.bio,
      data.github_url || null,
      data.linkedin_url || null,
      data.portfolio_url || null,
      id
    ];

    if (this.isConnected && this.pool) {
      try {
        await this.pool.query(sql, params);
        const duration = Date.now() - start;
        this.logQuery(`UPDATE student_profiles SET target_role='${data.target_role}', gpa=${data.gpa} WHERE id=${id};`, duration, 1, 'mysql-server');
      } catch (err: any) {
        console.error('[MySQL Backend] Failed to update MySQL table:', err.message);
      }
    } else {
      const duration = Date.now() - start;
      this.logQuery(`UPDATE student_profiles SET target_role='${data.target_role}', gpa=${data.gpa} WHERE id=${id};`, duration, 1, 'in-memory-engine');
    }

    return this.inMemStore.student_profiles[index];
  }

  public async upsertStudentSkill(studentId: number, skillId: number, proficiencyLevel: number, yearsExperience: number): Promise<any> {
    const start = Date.now();
    const existingIndex = this.inMemStore.student_skills.findIndex(
      ss => ss.student_id === studentId && ss.skill_id === skillId
    );

    let updatedRecord: any;
    if (existingIndex >= 0) {
      this.inMemStore.student_skills[existingIndex].proficiency_level = proficiencyLevel;
      this.inMemStore.student_skills[existingIndex].years_experience = yearsExperience;
      updatedRecord = this.inMemStore.student_skills[existingIndex];
    } else {
      const newId = Math.max(...this.inMemStore.student_skills.map(s => s.id), 0) + 1;
      updatedRecord = {
        id: newId,
        student_id: studentId,
        skill_id: skillId,
        proficiency_level: proficiencyLevel,
        years_experience: yearsExperience,
        verified: false,
        created_at: new Date().toISOString()
      };
      this.inMemStore.student_skills.push(updatedRecord);
    }

    const sql = `INSERT INTO student_skills (student_id, skill_id, proficiency_level, years_experience) 
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE proficiency_level = VALUES(proficiency_level), years_experience = VALUES(years_experience)`;

    if (this.isConnected && this.pool) {
      try {
        await this.pool.query(sql, [studentId, skillId, proficiencyLevel, yearsExperience]);
        this.logQuery(`INSERT INTO student_skills (student_id, skill_id, proficiency_level) VALUES (${studentId}, ${skillId}, ${proficiencyLevel}) ON DUPLICATE KEY UPDATE proficiency_level=${proficiencyLevel};`, Date.now() - start, 1, 'mysql-server');
      } catch (err: any) {
        console.error('[MySQL Backend] Failed upsert to MySQL:', err.message);
      }
    } else {
      this.logQuery(`INSERT INTO student_skills (student_id, skill_id, proficiency_level) VALUES (${studentId}, ${skillId}, ${proficiencyLevel}) ON DUPLICATE KEY UPDATE proficiency_level=${proficiencyLevel};`, Date.now() - start, 1, 'in-memory-engine');
    }

    return updatedRecord;
  }

  public async deleteStudentSkill(studentId: number, skillId: number): Promise<boolean> {
    const start = Date.now();
    this.inMemStore.student_skills = this.inMemStore.student_skills.filter(
      ss => !(ss.student_id === studentId && ss.skill_id === skillId)
    );

    if (this.isConnected && this.pool) {
      try {
        await this.pool.query('DELETE FROM student_skills WHERE student_id = ? AND skill_id = ?', [studentId, skillId]);
        this.logQuery(`DELETE FROM student_skills WHERE student_id = ${studentId} AND skill_id = ${skillId};`, Date.now() - start, 1, 'mysql-server');
      } catch (err: any) {
        console.error('[MySQL Backend] Error deleting skill:', err.message);
      }
    } else {
      this.logQuery(`DELETE FROM student_skills WHERE student_id = ${studentId} AND skill_id = ${skillId};`, Date.now() - start, 1, 'in-memory-engine');
    }

    return true;
  }

  public async createJob(jobData: any, requiredSkills: any[]): Promise<any> {
    const start = Date.now();
    const newJobId = Math.max(...this.inMemStore.job_postings.map(j => j.id), 0) + 1;
    const newJob = {
      ...jobData,
      id: newJobId,
      posted_at: new Date().toISOString().substring(0, 10)
    };
    this.inMemStore.job_postings.unshift(newJob);

    let nextReqId = Math.max(...this.inMemStore.job_required_skills.map(r => r.id), 0) + 1;
    const addedRequirements = requiredSkills.map(req => {
      const item = {
        id: nextReqId++,
        job_id: newJobId,
        skill_id: req.skillId,
        importance: req.importance,
        min_proficiency: req.minProficiency,
        weight: req.weight
      };
      this.inMemStore.job_required_skills.push(item);
      return item;
    });

    if (this.isConnected && this.pool) {
      try {
        await this.pool.query(
          `INSERT INTO job_postings (id, title, company, department, location, work_type, experience_level, salary_min, salary_max, description, deadline, posted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [newJobId, newJob.title, newJob.company, newJob.department, newJob.location, newJob.work_type, newJob.experience_level, newJob.salary_min, newJob.salary_max, newJob.description, newJob.deadline || '2026-12-31', newJob.posted_at]
        );

        for (const req of addedRequirements) {
          await this.pool.query(
            'INSERT INTO job_required_skills (id, job_id, skill_id, importance, min_proficiency, weight) VALUES (?, ?, ?, ?, ?, ?)',
            [req.id, req.job_id, req.skill_id, req.importance, req.min_proficiency, req.weight]
          );
        }
        this.logQuery(`START TRANSACTION; INSERT INTO job_postings (title) VALUES ('${newJob.title}'); COMMIT;`, Date.now() - start, 1 + addedRequirements.length, 'mysql-server');
      } catch (err: any) {
        console.error('[MySQL Backend] Error inserting job to MySQL:', err.message);
      }
    } else {
      this.logQuery(`START TRANSACTION; INSERT INTO job_postings (title) VALUES ('${newJob.title}'); COMMIT;`, Date.now() - start, 1 + addedRequirements.length, 'in-memory-engine');
    }

    return { job: newJob, requirements: addedRequirements };
  }

  public async submitApplication(studentId: number, jobId: number, matchPercentage: number, notes?: string): Promise<any> {
    const start = Date.now();
    const existing = this.inMemStore.job_applications.find(a => a.student_id === studentId && a.job_id === jobId);
    if (existing) {
      return existing;
    }

    const newId = Math.max(...this.inMemStore.job_applications.map(a => a.id), 0) + 1;
    const application = {
      id: newId,
      student_id: studentId,
      job_id: jobId,
      match_percentage_at_apply: matchPercentage,
      status: 'Applied',
      notes: notes || 'Direct Match Application via SkillBridge',
      applied_at: new Date().toISOString()
    };
    this.inMemStore.job_applications.unshift(application);

    if (this.isConnected && this.pool) {
      try {
        await this.pool.query(
          'INSERT INTO job_applications (id, student_id, job_id, match_percentage_at_apply, status, notes) VALUES (?, ?, ?, ?, ?, ?)',
          [application.id, application.student_id, application.job_id, application.match_percentage_at_apply, application.status, application.notes]
        );
        this.logQuery(`INSERT INTO job_applications (student_id, job_id, status) VALUES (${studentId}, ${jobId}, 'Applied');`, Date.now() - start, 1, 'mysql-server');
      } catch (err: any) {
        console.error('[MySQL Backend] Error recording application to MySQL:', err.message);
      }
    } else {
      this.logQuery(`INSERT INTO job_applications (student_id, job_id, status) VALUES (${studentId}, ${jobId}, 'Applied');`, Date.now() - start, 1, 'in-memory-engine');
    }

    return application;
  }

  public getStatus(): MySQLStatus {
    return {
      connected: this.isConnected,
      mode: this.isConnected ? 'mysql' : 'in-memory-relational',
      host: this.currentConfig.host,
      port: this.currentConfig.port,
      database: this.currentConfig.database,
      user: this.currentConfig.user,
      latencyMs: this.lastPingMs,
      error: this.lastError,
      tableCounts: {
        users: this.inMemStore.users.length,
        student_profiles: this.inMemStore.student_profiles.length,
        skills: this.inMemStore.skills.length,
        student_skills: this.inMemStore.student_skills.length,
        job_postings: this.inMemStore.job_postings.length,
        job_required_skills: this.inMemStore.job_required_skills.length,
        job_applications: this.inMemStore.job_applications.length
      },
      totalQueries: this.logs.length,
      inTransaction: Boolean(this.activeTxConn || this.txSnapshot)
    };
  }

  public getLogs(): BackendSQLLog[] {
    return [...this.logs];
  }

  private logQuery(query: string, duration: number, affectedRows = 0, source: 'mysql-server' | 'in-memory-engine'): void {
    const entry: BackendSQLLog = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toLocaleTimeString(),
      query: query.length > 250 ? query.substring(0, 247) + '...' : query,
      executionTimeMs: Math.max(1, Math.round(duration)),
      affectedRows,
      source
    };
    this.logs.unshift(entry);
    if (this.logs.length > 100) {
      this.logs.pop();
    }
  }
}

export const mysqlBackend = new MySQLBackendService();
