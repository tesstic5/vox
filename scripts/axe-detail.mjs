import { chromium } from 'playwright';
import axe from 'axe-core';
const BASE=process.env.VOXERA_BASE??'http://127.0.0.1:3000';
const r=await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'jordan@northwind.dev',password:'demo-password-2026'})});
const pair=(r.headers.get('set-cookie')??'').split(';')[0].split('=');
const b=await chromium.launch();const c=await b.newContext({viewport:{width:1440,height:900}});await c.addCookies([{name:pair[0],value:pair.slice(1).join('='),domain:'127.0.0.1',path:'/'}]);
for(const route of process.argv.slice(2)){const p=await c.newPage();await p.goto(BASE+route,{waitUntil:'networkidle'});await p.addScriptTag({content:axe.source});const x=await p.evaluate(()=>axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']},resultTypes:['violations']}));console.log('\n###',route);for(const v of x.violations){console.log('\n',v.id,v.impact,v.help,'nodes',v.nodes.length);for(const n of v.nodes.slice(0,30))console.log('-',n.target.join(' > '),'\n ',n.failureSummary?.replace(/\n/g,' '),'\n ',n.html.slice(0,300));}await p.close();}await b.close();
