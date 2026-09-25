/**
 * Copyright (c) 2026 Hamolus Labs
 * Author: Gilang Albathin Nurhabibi <athron98.github.io>
 * SPDX-License-Identifier: MIT
 */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function badRequest(message: string, code = 'BAD_REQUEST'): HttpError {
  return new HttpError(400, code, message)
}

export function notFound(message = 'Collection or record not found', code = 'NOT_FOUND'): HttpError {
  return new HttpError(404, code, message)
}

export function unauthorized(message = 'Unauthorized', code = 'UNAUTHORIZED'): HttpError {
  return new HttpError(401, code, message)
}

export function forbidden(message = 'Forbidden', code = 'FORBIDDEN'): HttpError {
  return new HttpError(403, code, message)
}