import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';

// rawBody: payment-provider webhook signatures are over the exact bytes received.
const app = await NestFactory.create(AppModule, {
  bufferLogs: true,
  rawBody: true,
});
const env = configureApp(app);
await app.listen(env.PORT);
