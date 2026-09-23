import "dotenv/config";
import express, {Request,Response,NextFunction} from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {z} from "zod";
import OpenAI from "openai";
import Stripe from "stripe";
import {PrismaClient} from "@prisma/client";

const prisma=new PrismaClient();
const app=express();
app.use(helmet());
app.use(cors({origin: process.env.CORS_ORIGIN?.split(",").map(x=>x.trim()) || true}));

const JWT=process.env.JWT_SECRET || "development-only-change-me";
const sign=(id:string)=>jwt.sign({sub:id},JWT,{expiresIn:"7d"});
type AuthedRequest=Request & {userId?:string};
function auth(req:AuthedRequest,res:Response,next:NextFunction){
  const h=req.headers.authorization;
  if(!h?.startsWith("Bearer ")) return res.status(401).json({error:"Não autenticado"});
  try { req.userId=(jwt.verify(h.slice(7),JWT) as any).sub; next(); }
  catch { return res.status(401).json({error:"Token inválido"}); }
}

const openai=process.env.OPENAI_API_KEY ? new OpenAI({apiKey:process.env.OPENAI_API_KEY}) : null;
const stripe=process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const APP_URL=(process.env.APP_URL || process.env.CORS_ORIGIN || "http://localhost:3000").split(",")[0].replace(/\/$/,"");

const PLANS={
  basic:{priceEnv:"STRIPE_PRICE_BASIC",credits:100},
  professional:{priceEnv:"STRIPE_PRICE_PROFESSIONAL",credits:300},
  agency:{priceEnv:"STRIPE_PRICE_AGENCY",credits:1000}
} as const;
type PaidPlan=keyof typeof PLANS;
function isPaidPlan(value:string): value is PaidPlan { return value in PLANS; }

// Stripe webhook MUST receive the raw request body for signature verification.
app.post("/api/billing/webhook", express.raw({type:"application/json"}), async (req,res)=>{
  if(!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send("Stripe webhook não configurado");
  const signature=req.headers["stripe-signature"];
  if(!signature || Array.isArray(signature)) return res.status(400).send("Assinatura Stripe ausente");
  let event:Stripe.Event;
  try { event=stripe.webhooks.constructEvent(req.body,signature,process.env.STRIPE_WEBHOOK_SECRET); }
  catch(err){ console.error("Stripe webhook signature error",err); return res.status(400).send("Webhook inválido"); }

  try {
    if(event.type==="checkout.session.completed"){
      const session=event.data.object as Stripe.Checkout.Session;
      const userId=session.metadata?.userId;
      const plan=session.metadata?.plan;
      const customerId=typeof session.customer==="string" ? session.customer : undefined;
      const subscriptionId=typeof session.subscription==="string" ? session.subscription : undefined;
      if(userId && customerId){
        await prisma.user.update({where:{id:userId},data:{
          stripeCustomerId:customerId,
          ...(subscriptionId?{stripeSubscriptionId:subscriptionId}:{}),
          ...(plan && isPaidPlan(plan)?{plan,subscriptionStatus:"active"}:{})
        }});
      }
    }

    if(event.type==="customer.subscription.created" || event.type==="customer.subscription.updated"){
      const sub=event.data.object as Stripe.Subscription;
      const customerId=typeof sub.customer==="string" ? sub.customer : undefined;
      const plan=sub.metadata?.plan;
      if(customerId){
        const user=await prisma.user.findFirst({where:{stripeCustomerId:customerId}});
        if(user){
          await prisma.user.update({where:{id:user.id},data:{
            stripeSubscriptionId:sub.id,
            subscriptionStatus:sub.status,
            currentPeriodEnd:new Date(sub.current_period_end*1000),
            ...(plan && isPaidPlan(plan)?{plan}: {})
          }});
        }
      }
    }

    if(event.type==="invoice.paid"){
      const invoice=event.data.object as Stripe.Invoice;
      const customerId=typeof invoice.customer==="string" ? invoice.customer : undefined;
      if(customerId){
        const user=await prisma.user.findFirst({where:{stripeCustomerId:customerId}});
        if(user && isPaidPlan(user.plan)){
          await prisma.user.update({where:{id:user.id},data:{
            credits:PLANS[user.plan].credits,
            subscriptionStatus:"active"
          }});
        }
      }
    }

    if(event.type==="invoice.payment_failed"){
      const invoice=event.data.object as Stripe.Invoice;
      const customerId=typeof invoice.customer==="string" ? invoice.customer : undefined;
      if(customerId){
        const user=await prisma.user.findFirst({where:{stripeCustomerId:customerId}});
        if(user) await prisma.user.update({where:{id:user.id},data:{subscriptionStatus:"past_due"}});
      }
    }

    if(event.type==="customer.subscription.deleted"){
      const sub=event.data.object as Stripe.Subscription;
      const customerId=typeof sub.customer==="string" ? sub.customer : undefined;
      if(customerId){
        const user=await prisma.user.findFirst({where:{stripeCustomerId:customerId}});
        if(user){
          await prisma.user.update({where:{id:user.id},data:{
            plan:"free",
            credits:20,
            subscriptionStatus:"canceled",
            stripeSubscriptionId:null,
            currentPeriodEnd:null
          }});
        }
      }
    }

    res.json({received:true});
  } catch(err){
    console.error("Stripe webhook processing error",err);
    res.status(500).send("Erro ao processar webhook");
  }
});

app.use(express.json({limit:"2mb"}));
app.use(rateLimit({windowMs:15*60*1000,max:300,standardHeaders:true,legacyHeaders:false}));

app.get("/api/health",(_,res)=>res.json({ok:true,service:"SOTSBA API",version:"2.2"}));

app.post("/api/auth/register",async(req,res)=>{
  const p=z.object({name:z.string().min(2),email:z.string().email(),password:z.string().min(8)}).parse(req.body);
  const exists=await prisma.user.findUnique({where:{email:p.email.toLowerCase()}});
  if(exists) return res.status(409).json({error:"E-mail já cadastrado"});
  const passwordHash=await bcrypt.hash(p.password,12);
  const user=await prisma.user.create({data:{name:p.name,email:p.email.toLowerCase(),passwordHash,company:{create:{name:p.name}}}});
  res.status(201).json({token:sign(user.id),user:{id:user.id,name:user.name,email:user.email,credits:user.credits,plan:user.plan}});
});

app.post("/api/auth/login",async(req,res)=>{
  const p=z.object({email:z.string().email(),password:z.string()}).parse(req.body);
  const user=await prisma.user.findUnique({where:{email:p.email.toLowerCase()}});
  if(!user || !(await bcrypt.compare(p.password,user.passwordHash))) return res.status(401).json({error:"E-mail ou senha inválidos"});
  res.json({token:sign(user.id),user:{id:user.id,name:user.name,email:user.email,credits:user.credits,plan:user.plan}});
});

app.get("/api/me",auth,async(req:AuthedRequest,res)=>{
  const user=await prisma.user.findUnique({where:{id:req.userId!},include:{company:true}});
  res.json(user);
});

app.put("/api/company",auth,async(req:AuthedRequest,res)=>{
  const p=z.object({name:z.string().min(2),segment:z.string().optional(),website:z.string().optional(),brandColor:z.string().optional(),logoUrl:z.string().optional()}).parse(req.body);
  const company=await prisma.company.upsert({where:{userId:req.userId!},create:{userId:req.userId!,...p},update:p});
  res.json(company);
});

app.get("/api/billing/config",auth,async(_req,res)=>{
  res.json({
    configured:Boolean(stripe && process.env.STRIPE_PRICE_BASIC && process.env.STRIPE_PRICE_PROFESSIONAL && process.env.STRIPE_PRICE_AGENCY),
    plans:{basic:{price:29.90,credits:100},professional:{price:59.90,credits:300},agency:{price:149.90,credits:1000}}
  });
});

app.post("/api/billing/checkout",auth,async(req:AuthedRequest,res)=>{
  if(!stripe) return res.status(503).json({error:"Pagamentos ainda não configurados no servidor"});
  const p=z.object({plan:z.enum(["basic","professional","agency"])}).parse(req.body);
  const priceId=process.env[PLANS[p.plan].priceEnv];
  if(!priceId) return res.status(503).json({error:`Preço Stripe do plano ${p.plan} não configurado`});
  const user=await prisma.user.findUnique({where:{id:req.userId!}});
  if(!user) return res.status(404).json({error:"Usuário não encontrado"});

  try{
    let customerId=user.stripeCustomerId || undefined;
    if(!customerId){
      const customer=await stripe.customers.create({email:user.email,name:user.name,metadata:{userId:user.id}});
      customerId=customer.id;
      await prisma.user.update({where:{id:user.id},data:{stripeCustomerId:customerId}});
    }
    const session=await stripe.checkout.sessions.create({
      mode:"subscription",
      customer:customerId,
      line_items:[{price:priceId,quantity:1}],
      success_url:`${APP_URL}/?billing=success`,
      cancel_url:`${APP_URL}/?billing=cancelled`,
      locale:"pt-BR",
      allow_promotion_codes:true,
      metadata:{userId:user.id,plan:p.plan},
      subscription_data:{metadata:{userId:user.id,plan:p.plan}}
    });
    res.json({url:session.url});
  }catch(err){
    console.error("Stripe checkout error",err);
    res.status(500).json({error:"Não foi possível iniciar o checkout"});
  }
});

app.post("/api/billing/portal",auth,async(req:AuthedRequest,res)=>{
  if(!stripe) return res.status(503).json({error:"Pagamentos ainda não configurados no servidor"});
  const user=await prisma.user.findUnique({where:{id:req.userId!}});
  if(!user?.stripeCustomerId) return res.status(400).json({error:"Você ainda não possui uma assinatura"});
  try{
    const session=await stripe.billingPortal.sessions.create({customer:user.stripeCustomerId,return_url:`${APP_URL}/?billing=portal`});
    res.json({url:session.url});
  }catch(err){
    console.error("Stripe portal error",err);
    res.status(500).json({error:"Não foi possível abrir o gerenciamento da assinatura"});
  }
});

async function consumeCredit(userId:string){
  const user=await prisma.user.findUnique({where:{id:userId}});
  if(!user || user.credits<1) throw new Error("CRÉDITOS_INSUFICIENTES");
  await prisma.user.update({where:{id:userId},data:{credits:{decrement:1}}});
}
async function saveGeneration(userId:string,type:string,prompt:string,result:string){
  return prisma.generation.create({data:{userId,type,prompt,result}});
}

app.post("/api/content/generate",auth,async(req:AuthedRequest,res)=>{
  const p=z.object({briefing:z.string().min(5),type:z.string().default("post"),tone:z.string().optional()}).parse(req.body);
  try{
    await consumeCredit(req.userId!);
    let result="";
    if(openai){
      const r=await openai.responses.create({model:process.env.OPENAI_TEXT_MODEL||"gpt-5",input:`Você é o estrategista de conteúdo da SOTSBA. Crie um ${p.type} profissional em português do Brasil. Tom: ${p.tone||"profissional e persuasivo"}. Briefing: ${p.briefing}`});
      result=r.output_text;
    }else result=`DEMO — Conteúdo para: ${p.briefing}\n\nNa produção, configure OPENAI_API_KEY para gerar o conteúdo real.`;
    await saveGeneration(req.userId!,"content",p.briefing,result);
    res.json({result});
  }catch(e:any){if(e.message==="CRÉDITOS_INSUFICIENTES") return res.status(402).json({error:e.message}); res.status(500).json({error:"Falha na geração"});}
});

app.post("/api/design/generate",auth,async(req:AuthedRequest,res)=>{
  const p=z.object({briefing:z.string().min(5),format:z.string().default("1080x1080"),style:z.string().optional()}).parse(req.body);
  try{
    await consumeCredit(req.userId!);
    if(!openai) {
      const result=JSON.stringify({mode:"demo",message:"Configure OPENAI_API_KEY para gerar a imagem real.",briefing:p.briefing});
      await saveGeneration(req.userId!,"design",p.briefing,result);
      return res.json({demo:true,result});
    }
    const prompt=`Crie uma peça publicitária profissional para uma empresa. Formato ${p.format}. Estilo ${p.style||"premium"}. Briefing: ${p.briefing}. Evite texto pequeno ou ilegível na imagem.`;
    const img=await openai.images.generate({model:process.env.OPENAI_IMAGE_MODEL||"gpt-image-2",prompt});
    const b64=(img as any).data?.[0]?.b64_json;
    const result=b64?`data:image/png;base64,${b64}`:"";
    await saveGeneration(req.userId!,"design",p.briefing,result?"[imagem gerada]":"[sem imagem]");
    res.json({result});
  }catch(e:any){if(e.message==="CRÉDITOS_INSUFICIENTES") return res.status(402).json({error:e.message}); res.status(500).json({error:"Falha na geração da arte"});}
});

app.get("/api/generations",auth,async(req:AuthedRequest,res)=>{
  const items=await prisma.generation.findMany({where:{userId:req.userId!},orderBy:{createdAt:"desc"},take:100});
  res.json(items);
});

app.listen(Number(process.env.PORT||4000),()=>console.log(`SOTSBA API na porta ${process.env.PORT||4000}`));
