/**
 * Domain-specific exceptions for the agy-format extension.
 */

import { ProxyError } from '../../core/exceptions.js';

export class AgyBinaryNotFoundError extends ProxyError {
  constructor(message, props) {
    super(message, { operation: 'agy-binary-resolution', ...props });
  }
}
