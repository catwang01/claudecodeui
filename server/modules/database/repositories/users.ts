import bcrypt from 'bcrypt';
import { getConnection } from '@/modules/database/connection.js';

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
  last_login: string | null;
  is_active: number;
  git_name: string | null;
  git_email: string | null;
  has_completed_onboarding: number;
};

export const usersDb = {
  createUser(username: string, passwordHash: string) {
    const db = getConnection();
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
    return { id: result.lastInsertRowid, username };
  },

  getUserByUsername(username: string): UserRow | null {
    const db = getConnection();
    return db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username) as UserRow | null ?? null;
  },

  getUserById(id: number): UserRow | null {
    const db = getConnection();
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | null ?? null;
  },

  updateLastLogin(userId: number): void {
    const db = getConnection();
    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
  },

  updateGitConfig(userId: number, gitName: string, gitEmail: string): void {
    const db = getConnection();
    db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?').run(gitName, gitEmail, userId);
  },

  setOnboardingComplete(userId: number): void {
    const db = getConnection();
    db.prepare('UPDATE users SET has_completed_onboarding = 1 WHERE id = ?').run(userId);
  },

  async verifyPassword(plaintext: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plaintext, hash);
  },

  async hashPassword(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, 12);
  },

  countUsers(): number {
    const db = getConnection();
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    return row.count;
  },

  getFirstUser(): UserRow | null {
    const db = getConnection();
    return db.prepare('SELECT * FROM users WHERE is_active = 1 LIMIT 1').get() as UserRow | null ?? null;
  },

  getGitConfig(userId: number): { git_name: string | null; git_email: string | null } | null {
    const db = getConnection();
    return db.prepare('SELECT git_name, git_email FROM users WHERE id = ?').get(userId) as { git_name: string | null; git_email: string | null } | null ?? null;
  },

  hasCompletedOnboarding(userId: number): boolean {
    const db = getConnection();
    const row = db.prepare('SELECT has_completed_onboarding FROM users WHERE id = ?').get(userId) as { has_completed_onboarding: number } | null;
    return row?.has_completed_onboarding === 1;
  },
};
