import React from 'react';
import {
  Briefcase,
  Database,
  Layers,
  Sparkles,
  Building2,
  TrendingUp,
  Edit3,
  LogOut
} from 'lucide-react';
import { StudentProfileRecord, UserRecord } from '../types/mysql-schema';
import { BackendStatus } from '../lib/api-client';

interface HeaderProps {
  activeTab: 'recommendations' | 'skills' | 'gap-analyzer' | 'employer' | 'mysql-studio';
  setActiveTab: (tab: 'recommendations' | 'skills' | 'gap-analyzer' | 'employer' | 'mysql-studio') => void;
  currentUser: UserRecord;
  currentStudent: StudentProfileRecord | null;
  onEditProfile: () => void;
  onLogout: () => void;
  backendStatus?: BackendStatus | null;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  currentUser,
  currentStudent,
  onEditProfile,
  onLogout,
  backendStatus
}) => {
  const isRecruiter = currentUser.role === 'recruiter';

  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-xs" id="skillbridge-main-header">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Top bar: Brand, Database Status, Authenticated Account */}
        <div className="py-3 flex flex-wrap items-center justify-between gap-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-blue-500 flex items-center justify-center text-white shadow-sm shadow-indigo-200">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-xl tracking-tight text-slate-900 whitespace-nowrap">SkillBridge</span>
              </div>
              <p className="text-xs text-slate-500 font-medium">Automated Skill Gap & Career Recommendation Engine</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Database Status */}
            <button
              onClick={() => setActiveTab('mysql-studio')}
              className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-800 text-xs font-medium transition cursor-pointer whitespace-nowrap"
              title="Click to open MySQL Database Studio & Connection Manager"
              id="header-mysql-status-badge"
            >
              <Database className="w-3.5 h-3.5 text-emerald-700" />
              <span className="font-semibold">MySQL 8.0</span>
              <span className="text-emerald-300">|</span>
              <span className="text-emerald-700">
                {backendStatus?.connected
                  ? `Connected (${backendStatus.latencyMs}ms)`
                  : (backendStatus?.mode === 'mysql' ? 'MySQL Connecting' : 'Backend Active')}
              </span>
            </button>

            {/* Authenticated User & Sign Out */}
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl p-1.5 pl-3">
              <div className="text-left">
                <div className="text-xs font-bold text-slate-800 whitespace-nowrap">{currentUser.full_name}</div>
                <div className="text-[11px] text-slate-500 truncate max-w-[180px]">
                  {currentStudent ? currentStudent.target_role : currentUser.email}
                </div>
              </div>

              {currentStudent && (
                <button
                  onClick={onEditProfile}
                  title="Edit student profile & career goals"
                  className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors cursor-pointer"
                  id="edit-profile-header-btn"
                >
                  <Edit3 className="w-4 h-4" />
                </button>
              )}

              <button
                onClick={onLogout}
                title="Sign out of your account"
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:text-red-700 hover:bg-red-50 bg-white border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                id="logout-header-btn"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center overflow-x-auto no-scrollbar gap-1 py-2">
          {!isRecruiter && (
            <>
              <button
                onClick={() => setActiveTab('recommendations')}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs sm:text-sm font-semibold whitespace-nowrap shrink-0 transition-all cursor-pointer ${
                  activeTab === 'recommendations'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
                id="nav-tab-recommendations"
              >
                <Briefcase className="w-4 h-4" />
                <span>Job Recommendations</span>
              </button>

              <button
                onClick={() => setActiveTab('skills')}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs sm:text-sm font-semibold whitespace-nowrap shrink-0 transition-all cursor-pointer ${
                  activeTab === 'skills'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
                id="nav-tab-skills"
              >
                <Layers className="w-4 h-4" />
                <span>Skill Inventory</span>
              </button>

              <button
                onClick={() => setActiveTab('gap-analyzer')}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs sm:text-sm font-semibold whitespace-nowrap shrink-0 transition-all cursor-pointer ${
                  activeTab === 'gap-analyzer'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
                id="nav-tab-gap-analyzer"
              >
                <TrendingUp className="w-4 h-4" />
                <span>Career Bridge & Gaps</span>
              </button>
            </>
          )}

          <button
            onClick={() => setActiveTab('employer')}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs sm:text-sm font-semibold whitespace-nowrap shrink-0 transition-all cursor-pointer ${
              activeTab === 'employer'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
            id="nav-tab-employer"
          >
            <Building2 className="w-4 h-4" />
            <span>Employer Portal</span>
          </button>

          <button
            onClick={() => setActiveTab('mysql-studio')}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs sm:text-sm font-semibold whitespace-nowrap shrink-0 transition-all cursor-pointer ${
              activeTab === 'mysql-studio'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
            id="nav-tab-mysql-studio"
          >
            <Database className="w-4 h-4 text-emerald-400" />
            <span>MySQL Database Studio</span>
          </button>
        </div>
      </div>
    </header>
  );
};
