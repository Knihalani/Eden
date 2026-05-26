"use client";

import { useAuth } from "@/hooks/use-auth";

export default function ProfilePage() {
  const { user } = useAuth();

  if (!user) return null;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-6">Profile</h1>
      <div className="bg-[var(--surface)] rounded-lg border border-[var(--border)] p-6">
        <div className="flex items-center gap-4 mb-6">
          <div className="user-avatar w-16 h-16 rounded-full flex items-center justify-center text-xl">
            {user.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">{user.name}</h2>
            <p className="text-sm text-[var(--text-muted)]">{user.email}</p>
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-[var(--text-secondary)]">User ID</label>
            <p className="text-sm text-[var(--text-primary)] font-mono">{user.user_id}</p>
          </div>
                  </div>
      </div>
    </div>
  );
}