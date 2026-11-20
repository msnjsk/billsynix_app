import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppException } from '../common/errors/app-exception.js';

/**
 * Access-token claims: user, business, membership and session. Kept minimal — rights, and whether
 * the session is still alive, are looked up live on every request.
 */
export type AccessClaims = {
  sub: string;
  tid: string;
  mid: string;
  sid: string;
};

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  signAccess(claims: AccessClaims): string {
    return this.jwt.sign(claims, { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
  }

  verifyAccess(token: string): AccessClaims {
    try {
      const p = this.jwt.verify<Partial<AccessClaims>>(token, {
        algorithms: ['HS256'],
      });
      if (
        typeof p.sub !== 'string' ||
        typeof p.tid !== 'string' ||
        typeof p.mid !== 'string' ||
        typeof p.sid !== 'string'
      ) {
        throw new Error('missing claims');
      }
      return { sub: p.sub, tid: p.tid, mid: p.mid, sid: p.sid };
    } catch (e) {
      const expired = (e as { name?: string }).name === 'TokenExpiredError';
      throw new AppException(
        expired ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED',
        expired ? 'Your session has expired.' : 'Sign in to continue.',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }
}
