import { UnavailableCapability } from '@/components/dash/UnavailableCapability';

export default function KnowledgePage() {
  return <UnavailableCapability title="Knowledge ingestion" description="File, URL and connected-workspace retrieval." boundary="This deployment retrieves only literal text snippets saved on an assistant. It does not parse uploaded documents, crawl URLs, create vector embeddings, sync Notion or Drive, report chunk counts, or measure retrieval p95. Edit real snippets on the assistant instead." links={[{ href: '/dashboard/assistants', label: 'Edit assistant snippets' }]} />;
}
