import { Controller, Get, HttpStatus } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PrismaService } from '../database/prisma.service.js';
import { AppException } from '../common/errors/app-exception.js';
import { Public } from '../auth/decorators.js';
import { SkipThrottle } from '@nestjs/throttler';

const startedAt = Date.now();

@ApiTags('health')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: the process is up. Never touches dependencies, so it can't cascade failures. */
  @Get()
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiOkResponse({ description: 'Process is running' })
  live() {
    return {
      status: 'ok',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    };
  }

  /** Readiness: dependencies answer. Load balancers stop routing here while it fails. */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe (database reachable)' })
  @ApiOkResponse({ description: 'Ready to serve traffic' })
  @ApiServiceUnavailableResponse({ description: 'A dependency is unavailable' })
  async ready() {
    const started = performance.now();
    try {
      await this.prisma.ping();
    } catch {
      throw new AppException(
        'SERVICE_UNAVAILABLE',
        'Database is not reachable.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return {
      status: 'ready',
      checks: {
        database: {
          status: 'up',
          latencyMs: Math.round(performance.now() - started),
        },
      },
    };
  }
}
