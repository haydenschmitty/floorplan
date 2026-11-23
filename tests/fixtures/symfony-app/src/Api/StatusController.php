<?php

namespace App\Api;

use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/status', name: 'status', methods: ['GET'])]
final class StatusController
{
    public function __invoke(): JsonResponse
    {
        return new JsonResponse(['ok' => true]);
    }
}
