import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';
export const alt='Provider connections require verification.'; export const size=OG_SIZE; export const contentType=OG_CONTENT_TYPE;
export default function Image(){return renderOg({eyebrow:'Connections',title:'Connect only providers you verify.',subtitle:'Credentials, delivery and settlement remain provider-specific.',meta:'No catalogue claim'});}
