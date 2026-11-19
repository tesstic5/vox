import * as React from 'react';

function Bone({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-slate-900/[0.05] ${className ?? ''}`} />;
}

export default function DashboardLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading dashboard view</span>
      <div className="flex flex-wrap items-center gap-3">
        <Bone className="h-8 w-52" />
        <Bone className="ml-auto h-9 w-32" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Bone key={i} className="h-[104px]" />
        ))}
      </div>
      <Bone className="h-[300px]" />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Bone className="h-[260px]" />
        <Bone className="h-[260px]" />
      </div>
    </div>
  );
}
