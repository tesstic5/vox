import * as React from 'react';

function Bone({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-slate-900/[0.05] ${className ?? ''}`} />;
}

export default function SiteLoading() {
  return (
    <div className="container-wide py-20" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading page</span>
      <Bone className="h-4 w-28" />
      <Bone className="mt-6 h-14 w-[min(100%,720px)]" />
      <Bone className="mt-4 h-14 w-[min(100%,520px)]" />
      <Bone className="mt-8 h-5 w-[min(100%,620px)]" />
      <Bone className="mt-3 h-5 w-[min(100%,560px)]" />
      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Bone key={i} className="h-[168px]" />
        ))}
      </div>
    </div>
  );
}
