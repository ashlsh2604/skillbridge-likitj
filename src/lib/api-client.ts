import {
  StudentProfileRecord,
  UserRecord,
  SkillRecord,
  StudentSkillRecord,
  JobPostingRecord,
  JobRequiredSkillRecord,
  JobApplicationRecord
} from '../types/mysql-schema';

export interface BackendStatus {
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
  inTransaction?: boolean;
}

export interface SQLLog {
  id: string;
  timestamp: string;
  query: string;
  executionTimeMs: number;
  affectedRows?: number;
  source: 'mysql-server' | 'in-memory-engine';
}

export interface SQLStatementSummary {
  statement: string;
  status: string;
  rowsAffected: number;
}

export interface SQLQueryResult {
  columns: string[];
  rows: any[];
  rowCount?: number;
  executionTimeMs: number;
  affectedRows: number;
  inTransaction?: boolean;
  statementSummaries?: SQLStatementSummary[];
  error?: string;
}

export interface FullDatasetResponse {
  users: UserRecord[];
  student_profiles: StudentProfileRecord[];
  skills: SkillRecord[];
  student_skills: StudentSkillRecord[];
  job_postings: JobPostingRecord[];
  job_required_skills: JobRequiredSkillRecord[];
  job_applications: JobApplicationRecord[];
  logs: SQLLog[];
  status?: BackendStatus;
}

export interface AuthResponse {
  user: UserRecord;
  profile: StudentProfileRecord | null;
  token: string;
}

export interface SignupPayload {
  email: string;
  password: string;
  fullName: string;
  role: 'student' | 'recruiter';
  university?: string;
  major?: string;
  degree?: string;
  graduationYear?: number;
  targetRole?: string;
}

const AUTH_TOKEN_STORAGE_KEY = 'skillbridge_auth_token';

class APIClient {
  public getStoredToken(): string | null {
    try {
      return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  public setStoredToken(token: string): void {
    try {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    } catch {
      // ignore storage errors
    }
  }

  public clearStoredToken(): void {
    try {
      localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
  }

  public async login(email: string, password: string): Promise<AuthResponse> {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Invalid email or password.');
    }
    if (data.token) {
      this.setStoredToken(data.token);
    }
    return data;
  }

  public async signup(payload: SignupPayload): Promise<AuthResponse> {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Could not create account.');
    }
    if (data.token) {
      this.setStoredToken(data.token);
    }
    return data;
  }

  public async getSession(token: string): Promise<{ user: UserRecord; profile: StudentProfileRecord | null } | null> {
    try {
      const res = await fetch('/api/auth/me', {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  public async logout(): Promise<void> {
    this.clearStoredToken();
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
  }

  public async getFullDataset(): Promise<FullDatasetResponse | null> {
    try {
      const res = await fetch('/api/data');
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn('[APIClient] Error fetching dataset from server:', err);
      return null;
    }
  }

  public async getMySQLStatus(): Promise<BackendStatus | null> {
    try {
      const res = await fetch('/api/mysql/status');
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn('[APIClient] Error fetching MySQL status:', err);
      return null;
    }
  }

  public async executeQuery(sql: string): Promise<SQLQueryResult> {
    try {
      const res = await fetch('/api/mysql/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql })
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err: any) {
      return {
        columns: ['error'],
        rows: [{ error: err.message || 'Execution failed' }],
        executionTimeMs: 0,
        affectedRows: 0,
        error: err.message
      };
    }
  }

  public async connectMySQL(config: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    ssl?: boolean;
  }): Promise<{ success: boolean; message: string; latencyMs: number; status: BackendStatus }> {
    const res = await fetch('/api/mysql/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Connection request failed');
    }
    return await res.json();
  }

  public async reseedDatabase(): Promise<FullDatasetResponse> {
    const res = await fetch('/api/mysql/reseed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error('Reseed request failed');
    const json = await res.json();
    return json.data;
  }

  public async updateStudentProfile(id: number, data: Partial<StudentProfileRecord>): Promise<any> {
    const res = await fetch(`/api/students/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error('Profile update failed');
    return await res.json();
  }

  public async upsertStudentSkill(studentId: number, skillId: number, proficiencyLevel: number, yearsExperience: number): Promise<any> {
    const res = await fetch('/api/student-skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId, skillId, proficiencyLevel, yearsExperience })
    });
    if (!res.ok) throw new Error('Skill upsert failed');
    return await res.json();
  }

  public async deleteStudentSkill(studentId: number, skillId: number): Promise<boolean> {
    const res = await fetch(`/api/student-skills/${studentId}/${skillId}`, {
      method: 'DELETE'
    });
    return res.ok;
  }

  public async createJob(job: any, requiredSkills: any[]): Promise<any> {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job, requiredSkills })
    });
    if (!res.ok) throw new Error('Job creation failed');
    return await res.json();
  }

  public async submitApplication(studentId: number, jobId: number, matchPercentage: number, notes?: string): Promise<any> {
    const res = await fetch('/api/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId, jobId, matchPercentage, notes })
    });
    if (!res.ok) throw new Error('Application submission failed');
    return await res.json();
  }
}

export const apiClient = new APIClient();
