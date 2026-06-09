import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { createHash } from "crypto";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Optional password gate — only active when APP_PASSWORD env var is set
app.use("/api", (req: Request, res: Response, next: NextFunction): void => {
  const pw = process.env.APP_PASSWORD;
  if (!pw) { next(); return; }

  const PUBLIC = ["/auth/login", "/healthz"];
  if (PUBLIC.some(p => req.path === p)) { next(); return; }

  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) { res.status(401).json({ error: "Unauthorized" }); return; }

  const token = header.slice(7);
  const expected = createHash("sha256").update(pw).digest("hex");
  if (token !== expected) { res.status(401).json({ error: "Unauthorized" }); return; }

  next();
});

app.use("/api", router);

export default app;
