import React, { useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Building2,
  Eye,
  EyeOff,
  GraduationCap,
  Lock,
  Mail,
  User
} from 'lucide-react';
import { apiClient, AuthResponse } from '../lib/api-client';

interface AuthPageProps {
  onAuthSuccess: (auth: AuthResponse) => void;
}

export const AuthPage: React.FC<AuthPageProps> = ({ onAuthSuccess }) => {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [role, setRole] = useState<'student' | 'recruiter'>('student');

  // Shared form fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Sign-up fields
  const [fullName, setFullName] = useState('');
  const [university, setUniversity] = useState('');
  const [major, setMajor] = useState('');
  const [graduationYear, setGraduationYear] = useState('2027');
  const [targetRole, setTargetRole] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const switchMode = (nextMode: 'login' | 'signup') => {
    setMode(nextMode);
    setErrorMessage(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }

    if (password.length < 6) {
      setErrorMessage('Password must be at least 6 characters.');
      return;
    }

    if (mode === 'signup') {
      if (fullName.trim().length < 2) {
        setErrorMessage('Please enter your full name.');
        return;
      }
      if (password !== confirmPassword) {
        setErrorMessage('Passwords do not match.');
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const response =
        mode === 'login'
          ? await apiClient.login(normalizedEmail, password)
          : await apiClient.signup({
              email: normalizedEmail,
              password,
              fullName: fullName.trim(),
              role,
              university: role === 'student' ? university.trim() : undefined,
              major: role === 'student' ? major.trim() : undefined,
              graduationYear: role === 'student' ? Number(graduationYear) || 2027 : undefined,
              targetRole: role === 'student' ? targetRole.trim() : undefined
            });
      onAuthSuccess(response);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Authentication failed. Please try again.';
      setErrorMessage(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 grid grid-cols-1 lg:grid-cols-12" id="auth-page-root">
      {/* Left Context Panel */}
      <aside className="lg:col-span-5 bg-slate-900 text-slate-100 p-8 sm:p-12 lg:p-14 flex flex-col justify-between">
        <div className="space-y-10 max-w-md">
          <div>
            <span className="text-xl font-bold tracking-tight text-white">SkillBridge</span>
            <p className="text-xs text-slate-400 mt-1">Student Skill & Career Matcher</p>
          </div>

          <div className="space-y-4">
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white leading-tight [text-wrap:balance]">
              Match verified skills directly to engineering careers.
            </h1>
            <p className="text-sm text-slate-300 leading-relaxed">
              Manage your competency matrix in a relational MySQL workspace, analyze skill gaps against live roles, and surface high-fit opportunities.
            </p>
          </div>

          <div className="divide-y divide-slate-800 border-t border-b border-slate-800 text-sm">
            <div className="py-4">
              <div className="font-semibold text-white">Relational Skill Modeling</div>
              <p className="text-xs text-slate-400 mt-1">
                Student profiles, verified skill proficiencies, and job requirement weights persist directly in MySQL tables.
              </p>
            </div>
            <div className="py-4">
              <div className="font-semibold text-white">Automated Fit Scoring</div>
              <p className="text-xs text-slate-400 mt-1">
                Every proficiency update recalculates cosine and weighted skill alignment across active openings.
              </p>
            </div>
            <div className="py-4">
              <div className="font-semibold text-white">Actionable Career Roadmaps</div>
              <p className="text-xs text-slate-400 mt-1">
                Simulate missing competencies and generate tailored preparation plans before submitting applications.
              </p>
            </div>
          </div>
        </div>

        <p className="text-xs text-slate-500 mt-10">
          SkillBridge Career Matcher · MySQL Relational Backend
        </p>
      </aside>

      {/* Right Authentication Form Panel */}
      <main className="lg:col-span-7 flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6">
          <div className="space-y-1.5">
            <h2 className="text-2xl font-bold tracking-tight text-slate-900">
              {mode === 'login' ? 'Sign in to your account' : 'Create your SkillBridge account'}
            </h2>
            <p className="text-sm text-slate-500">
              {mode === 'login'
                ? 'Enter your credentials to access your profile and career matches.'
                : 'Register a student or recruiter profile stored in MySQL.'}
            </p>
          </div>

          {/* Mode Segmented Toggle */}
          <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg" role="tablist" aria-label="Authentication mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              onClick={() => switchMode('login')}
              className={`py-2 px-4 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                mode === 'login'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
              id="auth-tab-login"
            >
              Sign In
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'signup'}
              onClick={() => switchMode('signup')}
              className={`py-2 px-4 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                mode === 'signup'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
              id="auth-tab-signup"
            >
              Sign Up
            </button>
          </div>

          {/* Error Feedback */}
          {errorMessage && (
            <div
              role="alert"
              className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs font-medium flex items-start gap-2.5"
              id="auth-error-banner"
            >
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            {mode === 'signup' && (
              <>
                {/* Account Role Selector */}
                <div className="space-y-1.5">
                  <span className="block text-xs font-semibold text-slate-700">Account Type</span>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setRole('student')}
                      className={`py-2.5 px-3 rounded-lg border text-xs font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap cursor-pointer ${
                        role === 'student'
                          ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                      id="signup-role-student"
                    >
                      <GraduationCap className="w-4 h-4" />
                      <span>Student</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setRole('recruiter')}
                      className={`py-2.5 px-3 rounded-lg border text-xs font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap cursor-pointer ${
                        role === 'recruiter'
                          ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                      id="signup-role-recruiter"
                    >
                      <Building2 className="w-4 h-4" />
                      <span>Recruiter</span>
                    </button>
                  </div>
                </div>

                {/* Full Name */}
                <div className="space-y-1">
                  <label htmlFor="auth-fullname" className="block text-xs font-semibold text-slate-700">
                    Full Name
                  </label>
                  <div className="relative">
                    <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="auth-fullname"
                      type="text"
                      required
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Jordan Taylor"
                      className="w-full pl-9 pr-3 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600"
                    />
                  </div>
                </div>
              </>
            )}

            {/* Email */}
            <div className="space-y-1">
              <label htmlFor="auth-email" className="block text-xs font-semibold text-slate-700">
                Email Address
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  id="auth-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@university.edu"
                  className="w-full pl-9 pr-3 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600"
                />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-1">
              <label htmlFor="auth-password" className="block text-xs font-semibold text-slate-700">
                Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  id="auth-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === 'login' ? 'Enter your password' : 'Minimum 6 characters'}
                  className="w-full pl-9 pr-10 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {mode === 'signup' && (
              <>
                {/* Confirm Password */}
                <div className="space-y-1">
                  <label htmlFor="auth-confirm-password" className="block text-xs font-semibold text-slate-700">
                    Confirm Password
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="auth-confirm-password"
                      type={showPassword ? 'text' : 'password'}
                      required
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter your password"
                      className="w-full pl-9 pr-3 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600"
                    />
                  </div>
                </div>

                {/* Student Academic Profile Fields */}
                {role === 'student' && (
                  <div className="pt-2 border-t border-slate-100 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label htmlFor="auth-university" className="block text-xs font-semibold text-slate-700">
                          University
                        </label>
                        <input
                          id="auth-university"
                          type="text"
                          value={university}
                          onChange={(e) => setUniversity(e.target.value)}
                          placeholder="e.g. UC Berkeley"
                          className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-600"
                        />
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="auth-major" className="block text-xs font-semibold text-slate-700">
                          Major
                        </label>
                        <input
                          id="auth-major"
                          type="text"
                          value={major}
                          onChange={(e) => setMajor(e.target.value)}
                          placeholder="e.g. Computer Science"
                          className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-600"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label htmlFor="auth-target-role" className="block text-xs font-semibold text-slate-700">
                          Target Career Role
                        </label>
                        <input
                          id="auth-target-role"
                          type="text"
                          value={targetRole}
                          onChange={(e) => setTargetRole(e.target.value)}
                          placeholder="e.g. Backend Engineer"
                          className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-600"
                        />
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="auth-grad-year" className="block text-xs font-semibold text-slate-700">
                          Graduation Year
                        </label>
                        <input
                          id="auth-grad-year"
                          type="number"
                          min={2024}
                          max={2032}
                          value={graduationYear}
                          onChange={(e) => setGraduationYear(e.target.value)}
                          className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 tabular-nums focus:outline-none focus:ring-2 focus:ring-indigo-600"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors whitespace-nowrap cursor-pointer"
              id="auth-submit-btn"
            >
              <span>
                {isSubmitting
                  ? mode === 'login'
                    ? 'Signing in...'
                    : 'Creating account...'
                  : mode === 'login'
                  ? 'Sign In'
                  : 'Create Account'}
              </span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>

          <div className="pt-4 border-t border-slate-100 text-center text-xs text-slate-500">
            {mode === 'login' ? (
              <span>
                New to SkillBridge?{' '}
                <button
                  type="button"
                  onClick={() => switchMode('signup')}
                  className="font-semibold text-indigo-600 hover:text-indigo-700 hover:underline cursor-pointer"
                >
                  Create an account
                </button>
              </span>
            ) : (
              <span>
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => switchMode('login')}
                  className="font-semibold text-indigo-600 hover:text-indigo-700 hover:underline cursor-pointer"
                >
                  Sign in instead
                </button>
              </span>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};
