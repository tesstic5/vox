import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';
export const alt='Provider connection boundary.'; export const size=OG_SIZE; export const contentType=OG_CONTENT_TYPE;
export default function Image(){return renderOg({eyebrow:'Connections',title:'Provider setup needs live verification.',subtitle:'No connection is represented as available until credentials and delivery are tested.',meta:'Deployment-specific'});}
