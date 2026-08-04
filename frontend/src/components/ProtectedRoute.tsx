import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="text-slate-400">Loading...</p>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
