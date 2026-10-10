import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";

const {GROQ_KEY,GEMINI_KEY,PIX_TOKEN,PORT=10000}=process.env;
const H={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Authorization,Content-Type","Access-Control-Allow-Methods":"GET,POST,OPTIONS"};
const hits=new Map();
const limited=ip=>{const n=Date.now(),a=(hits.get(ip)||[]).filter(t=>n-t<60000);a.push(n);hits.set(ip,a);return a.length>40};
const body=req=>new Promise((ok,no)=>{let s="";req.on("data",c=>{s+=c;if(s.length>2e6){no(new Error("big"));req.destroy()}});req.on("end",()=>ok(s));req.on("error",no)});
const send=(res,code,obj)=>{res.writeHead(code,{...H,"Content-Type":"application/json"});res.end(JSON.stringify(obj))};

async function pipe(res,url,headers,b){
  const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:b});
  res.writeHead(r.status,{...H,"Content-Type":r.headers.get("content-type")||"text/plain"});
  for await(const c of r.body)res.write(c);
  res.end();
}

// تشغيل ملفات js/py في مجلد مؤقت، بدون مفاتيح في البيئة، مع حد وقت وحجم
async function run({lang,entry,files}){
  if(!["js","py"].includes(lang)||!Array.isArray(files)||!files.length||files.length>20)throw new Error("bad request");
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"pix-"));
  try{
    for(const f of files){
      const p=path.normalize(String(f.name)).replace(/^([/\\]|\.\.)+/,"");
      if(!p||p.includes(".."))continue;
      await fs.mkdir(path.dirname(path.join(dir,p)),{recursive:true});
      await fs.writeFile(path.join(dir,p),String(f.content).slice(0,500000));
    }
    const main=files.find(f=>f.name===entry)?entry:files.find(f=>f.name.endsWith("."+lang)).name;
    return await new Promise(ok=>{
      const c=spawn(lang==="js"?"node":"python3",[main],{cwd:dir,env:{PATH:process.env.PATH,HOME:dir},timeout:15000,killSignal:"SIGKILL"});
      let out="";const add=d=>{if(out.length<100000)out+=d};
      c.stdout.on("data",add);c.stderr.on("data",add);
      c.on("close",code=>ok({out:out||"(لا يوجد ناتج)",code}));
      c.on("error",e=>ok({out:String(e),code:-1}));
    });
  }finally{fs.rm(dir,{recursive:true,force:true}).catch(()=>{})}
}

http.createServer(async(req,res)=>{
  try{
    if(req.method==="OPTIONS"){res.writeHead(204,H);return res.end()}
    const url=new URL(req.url,"http://x");
    if(url.pathname==="/"||url.pathname==="/health")return send(res,200,{ok:true,name:"Pix server"});
    if(!PIX_TOKEN||req.headers.authorization!=="Bearer "+PIX_TOKEN)return send(res,401,{error:"unauthorized"});
    if(limited(req.socket.remoteAddress))return send(res,429,{error:"too many requests"});
    if(req.method!=="POST")return send(res,404,{error:"not found"});
    const b=await body(req);
    if(url.pathname==="/groq")return pipe(res,"https://api.groq.com/openai/v1/chat/completions",{Authorization:"Bearer "+GROQ_KEY},b);
    const g=url.pathname.match(/^\/gemini\/([\w.-]+)$/);
    if(g)return pipe(res,`https://generativelanguage.googleapis.com/v1beta/models/${g[1]}:streamGenerateContent?alt=sse`,{"x-goog-api-key":GEMINI_KEY},b);
    if(url.pathname==="/run")return send(res,200,await run(JSON.parse(b)));
    send(res,404,{error:"not found"});
  }catch(e){if(!res.headersSent)send(res,500,{error:String(e.message||e)});else res.end()}
}).listen(PORT,()=>console.log("Pix server on",PORT));
