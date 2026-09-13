import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { APP_OPTIONS, configureApp } from './app-setup';
import {
  describeSessionCookieMode,
  sessionCookieModeIsWeakened,
} from './auth/session-cookie';
import { loadEnv, loadEnvFile } from './config/env';
import { JsonLogger } from './observability/json-logger';

async function bootstrap(): Promise<void> {
  // `.env` first, then validation — so a misconfigured deployment fails
  // immediately and with a readable message instead of at the first request.
  loadEnvFile();
  const env = loadEnv();
  // **Machine-readable only in production** (ADR-0016): in
  // development a human reads the terminal, and JSON would be harder to read
  // there than Nest's coloured lines. In operation nobody is
  // watching, and `grep` can do nothing with colours.
  const options =
    env.NODE_ENV === 'production'
      ? { ...APP_OPTIONS, logger: new JsonLogger() }
      : APP_OPTIONS;
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    options,
  );
  // The same options and the same call the integration tests make, so the
  // application under test is the application that ships.
  configureApp(app, env);
  await app.listen(env.API_PORT, '0.0.0.0');
  Logger.log(
    `API listening on port ${String(env.API_PORT)} (version ${env.APP_VERSION})`,
    'Bootstrap',
  );
  // The shape of the session cookie, said out loud. Two variables decide it and
  // getting it wrong does not fail anything — the login answers 200, the
  // browser drops the cookie, and every request afterwards is anonymous. An
  // operator must be able to see this state without inspecting cookies in a
  // browser; the sentence and the level both live next to the decision
  // (`auth/session-cookie.ts`).
  const sessionCookieMode = describeSessionCookieMode(env);
  if (sessionCookieModeIsWeakened(env)) {
    Logger.warn(sessionCookieMode, 'Bootstrap');
  } else {
    Logger.log(sessionCookieMode, 'Bootstrap');
  }
}

void bootstrap();
