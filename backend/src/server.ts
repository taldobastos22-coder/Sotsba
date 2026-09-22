import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const app = express();

app.use(helmet());

app.use(
  cors({
    origin:
      process.env.CORS_ORIGIN?.split(",").map((x) => x.trim()) || true,
  })
);

app.use(express.json({ limit: "2mb" }));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const JWT = process.env.JWT_SECRET || "development-only-change-me";

const sign = (id: string) =>
  jwt.sign({ sub: id }, JWT, { expiresIn: "7d" });

type AuthedRequest = Request & { userId?: string };

function auth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  const h = req.headers.authorization;

  if (!h?.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Não autenticado",
    });
  }

  try {
    req.userId = (
      jwt.verify(h.slice(7), JWT) as any
    ).sub;

    next();
  } catch {
    return res.status(401).json({
      error: "Token inválido",
    });
  }
}

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })
  : null;

app.get("/api/health", (_, res) => {
  res.json({
    ok: true,
    service: "SOTSBA API",
    version: "2.0",
  });
});

app.post("/api/auth/register", async (req, res) => {
  const p = z
    .object({
      name: z.string().min(2),
      email: z.string().email(),
      password: z.string().min(8),
    })
    .parse(req.body);

  const exists = await prisma.user.findUnique({
    where: {
      email: p.email.toLowerCase(),
    },
  });

  if (exists) {
    return res.status(409).json({
      error: "E-mail já cadastrado",
    });
  }

  const passwordHash = await bcrypt.hash(
    p.password,
    12
  );

  const user = await prisma.user.create({
    data: {
      name: p.name,
      email: p.email.toLowerCase(),
      passwordHash,
      company: {
        create: {
          name: p.name,
        },
      },
    },
  });

  res.status(201).json({
    token: sign(user.id),
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      credits: user.credits,
      plan: user.plan,
    },
  });
});

app.post("/api/auth/login", async (req, res) => {
  const p = z
    .object({
      email: z.string().email(),
      password: z.string(),
    })
    .parse(req.body);

  const user = await prisma.user.findUnique({
    where: {
      email: p.email.toLowerCase(),
    },
  });

  if (
    !user ||
    !(await bcrypt.compare(
      p.password,
      user.passwordHash
    ))
  ) {
    return res.status(401).json({
      error: "E-mail ou senha inválidos",
    });
  }

  res.json({
    token: sign(user.id),
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      credits: user.credits,
      plan: user.plan,
    },
  });
});

app.get(
  "/api/me",
  auth,
  async (req: AuthedRequest, res) => {
    const user = await prisma.user.findUnique({
      where: {
        id: req.userId!,
      },
      include: {
        company: true,
      },
    });

    res.json(user);
  }
);

app.put(
  "/api/company",
  auth,
  async (req: AuthedRequest, res) => {
    const p = z
      .object({
        name: z.string().min(2),
        segment: z.string().optional(),
        website: z.string().optional(),
        brandColor: z.string().optional(),
        logoUrl: z.string().optional(),
      })
      .parse(req.body);

    const company = await prisma.company.upsert({
      where: {
        userId: req.userId!,
      },
      create: {
        userId: req.userId!,
        ...p,
      },
      update: p,
    });

    res.json(company);
  }
);

async function consumeCredit(userId: string) {
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
  });

  if (!user || user.credits < 1) {
    throw new Error("CRÉDITOS_INSUFICIENTES");
  }

  await prisma.user.update({
    where: {
      id: userId,
    },
    data: {
      credits: {
        decrement: 1,
      },
    },
  });
}

async function saveGeneration(
  userId: string,
  type: string,
  prompt: string,
  result: string
) {
  return prisma.generation.create({
    data: {
      userId,
      type,
      prompt,
      result,
    },
  });
}

app.post(
  "/api/content/generate",
  auth,
  async (req: AuthedRequest, res) => {
    const p = z
      .object({
        briefing: z.string().min(5),
        type: z.string().default("post"),
        tone: z.string().optional(),
      })
      .parse(req.body);

    try {
      await consumeCredit(req.userId!);

      let result = "";

      if (openai) {
        const r = await openai.responses.create({
          model:
            process.env.OPENAI_TEXT_MODEL || "gpt-5",
          input: `Você é o estrategista de conteúdo da SOTSBA. Crie um ${p.type} profissional em português do Brasil. Tom: ${p.tone || "profissional e persuasivo"}. Briefing: ${p.briefing}`,
        });

        result = r.output_text;
      } else {
        result = `DEMO — Conteúdo para: ${p.briefing}

Na produção, configure OPENAI_API_KEY para gerar o conteúdo real.`;
      }

      await saveGeneration(
        req.userId!,
        "content",
        p.briefing,
        result
      );

      res.json({
        result,
      });
    } catch (e: any) {
      if (
        e.message === "CRÉDITOS_INSUFICIENTES"
      ) {
        return res.status(402).json({
          error: e.message,
        });
      }

      res.status(500).json({
        error: "Falha na geração",
      });
    }
  }
);

app.post(
  "/api/design/generate",
  auth,
  async (req: AuthedRequest, res) => {
    const p = z
      .object({
        briefing: z.string().min(5),
        format: z
          .string()
          .default("1080x1080"),
        style: z.string().optional(),
      })
      .parse(req.body);

    try {
      await consumeCredit(req.userId!);

      if (!openai) {
        const result = JSON.stringify({
          mode: "demo",
          message:
            "Configure OPENAI_API_KEY para gerar a imagem real.",
          briefing: p.briefing,
        });

        await saveGeneration(
          req.userId!,
          "design",
          p.briefing,
          result
        );

        return res.json({
          demo: true,
          result,
        });
      }

      const prompt = `Crie uma peça publicitária profissional para uma empresa. Formato ${p.format}. Estilo ${p.style || "premium"}. Briefing: ${p.briefing}. Evite texto pequeno ou ilegível na imagem.`;

      const img = await openai.images.generate({
        model:
          process.env.OPENAI_IMAGE_MODEL ||
          "gpt-image-2",
        prompt,
      });

      const b64 = (img as any).data?.[0]?.b64_json;

      const result = b64
        ? `data:image/png;base64,${b64}`
        : "";

      await saveGeneration(
        req.userId!,
        "design",
        p.briefing,
        result
          ? "[imagem gerada]"
          : "[sem imagem]"
      );

      res.json({
        result,
      });
    } catch (e: any) {
      if (
        e.message === "CRÉDITOS_INSUFICIENTES"
      ) {
        return res.status(402).json({
          error: e.message,
        });
      }

      res.status(500).json({
        error: "Falha na geração da arte",
      });
    }
  }
);

app.get(
  "/api/generations",
  auth,
  async (req: AuthedRequest, res) => {
    const items =
      await prisma.generation.findMany({
        where: {
          userId: req.userId!,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 100,
      });

    res.json(items);
  }
);

app.listen(
  Number(process.env.PORT || 4000),
  () =>
    console.log(
      `SOTSBA API na porta ${
        process.env.PORT || 4000
      }`
    )
);
