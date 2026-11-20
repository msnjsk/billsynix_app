import {
  BadRequestException,
  HttpStatus,
  NotFoundException,
  type ArgumentsHost,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { AppException } from '../errors/app-exception.js';

function run(exception: unknown) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ id: 'req-12345678', originalUrl: '/x' }),
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;
  const filter = new AllExceptionsFilter();
  vi.spyOn(
    (filter as unknown as { logger: { error: () => void } }).logger,
    'error',
  ).mockImplementation(() => undefined);
  filter.catch(exception, host);
  return {
    status: res.status.mock.calls[0]?.[0] as number,
    body: res.json.mock.calls[0]?.[0] as { error: Record<string, unknown> },
  };
}

describe('AllExceptionsFilter', () => {
  it('formats AppException with code, details and request id', () => {
    const r = run(
      new AppException(
        'STOCK_INSUFFICIENT',
        'Only 3 left',
        HttpStatus.CONFLICT,
        [{ field: 'lines.0.qty', issue: 'exceeds_stock' }],
      ),
    );
    expect(r.status).toBe(409);
    expect(r.body.error).toEqual({
      code: 'STOCK_INSUFFICIENT',
      message: 'Only 3 left',
      details: [{ field: 'lines.0.qty', issue: 'exceeds_stock' }],
      requestId: 'req-12345678',
    });
  });

  it('maps framework HttpExceptions to standard codes', () => {
    expect(
      run(new NotFoundException('Cannot GET /nope')).body.error,
    ).toMatchObject({ code: 'NOT_FOUND', message: 'Cannot GET /nope' });
    expect(run(new BadRequestException(['a', 'b'])).body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'a; b',
    });
  });

  it('maps Prisma unique and not-found errors without leaking internals', () => {
    const p2002 = Object.assign(
      new Error('Unique constraint failed on users_email_key'),
      { name: 'PrismaClientKnownRequestError', code: 'P2002' },
    );
    const r = run(p2002);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(JSON.stringify(r.body)).not.toContain('users_email_key');
    expect(
      run(
        Object.assign(new Error('x'), {
          name: 'PrismaClientKnownRequestError',
          code: 'P2025',
        }),
      ).status,
    ).toBe(404);
  });

  it('hides unknown errors behind a generic 500', () => {
    const r = run(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'),
    );
    expect(r.status).toBe(500);
    expect(r.body.error).toEqual({
      code: 'INTERNAL',
      message: 'Something went wrong.',
      requestId: 'req-12345678',
    });
  });

  it('handles body-parser errors', () => {
    const r = run(
      Object.assign(new SyntaxError('Unexpected token'), {
        status: 400,
        type: 'entity.parse.failed',
      }),
    );
    expect(r).toMatchObject({
      status: 400,
      body: {
        error: { code: 'VALIDATION_FAILED', message: 'Malformed JSON body.' },
      },
    });
  });
});
