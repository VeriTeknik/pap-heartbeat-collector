/**
 * Authentication Middleware
 *
 * Protects sensitive endpoints (like /agents) with API key authentication.
 * Supports two header formats:
 * - X-Collector-Key: <key>
 * - Authorization: Bearer <key>
 */

import type { Request, Response, NextFunction } from 'express';
import type { Config } from '../config.js';

/**
 * Create middleware that requires API key authentication.
 *
 * If COLLECTOR_API_KEY is not configured, requests are allowed through
 * (dev mode). In production, always set COLLECTOR_API_KEY.
 */
export function requireApiKey(config: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // If no API key configured, allow through (dev mode with warning on startup)
    if (!config.collectorApiKey) {
      next();
      return;
    }

    // Check X-Collector-Key header first
    const collectorKey = req.headers['x-collector-key'];
    if (collectorKey === config.collectorApiKey) {
      next();
      return;
    }

    // Check Authorization: Bearer <key> header
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const bearerToken = authHeader.slice(7);
      if (bearerToken === config.collectorApiKey) {
        next();
        return;
      }
    }

    // Authentication failed
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Valid API key required. Use X-Collector-Key or Authorization: Bearer header.',
    });
  };
}
