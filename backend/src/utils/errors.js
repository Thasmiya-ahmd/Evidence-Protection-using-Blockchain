export class AppError extends Error {
  constructor(status, code, message, options = {}) {
    super(message, options)
    this.name = 'AppError'
    this.status = status
    this.code = code
  }
}

export const badRequest = (message = 'Request validation failed') =>
  new AppError(400, 'BAD_REQUEST', message)

export function notFound(message = 'Resource not found') {
  return new AppError(404, 'NOT_FOUND', message)
}

export function conflict(message = 'The resource conflicts with existing data') {
  return new AppError(409, 'CONFLICT', message)
}

export function forbidden(message = 'You are not authorized to access this resource') {
  return new AppError(403, 'FORBIDDEN', message)
}

export function unauthorized(message = 'Authentication is required') {
  return new AppError(401, 'UNAUTHORIZED', message)
}

export function unavailable(message = 'Blockchain service is unavailable') {
  return new AppError(503, 'SERVICE_UNAVAILABLE', message)
}

export function errorHandler(error, _request, response, _next) {
  if (response.headersSent) return
  const status = Number.isInteger(error.status) ? error.status : 500
  const code = error.code || (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR')
  if (status >= 500) console.error('Request failed:', code, error.message)
  response.status(status).json({
    error: code,
    message: status >= 500 ? 'An internal service error occurred' : error.message,
  })
}
