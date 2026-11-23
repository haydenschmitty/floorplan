<?php

namespace App\Controller;

use Symfony\Component\HttpFoundation\JsonResponse;

final class HealthController
{
    /** Tells the load balancer the shop is up. */
    public function __invoke(): JsonResponse
    {
        return new JsonResponse(['ok' => true]);
    }
}
