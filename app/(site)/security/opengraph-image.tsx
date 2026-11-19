import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';
export const alt='Implemented security controls and explicit external boundaries.'; export const size=OG_SIZE; export const contentType=OG_CONTENT_TYPE;
export default function Image(){return renderOg({eyebrow:'Security boundaries',title:'Verify controls in code and deployment.',subtitle:'Tenant, role, account, key and audit controls without certification claims.',meta:'Independent review required'});}
