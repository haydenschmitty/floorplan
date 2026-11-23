<?php

namespace App\Admin;

use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;

class ReportController
{
    #[Route('/reports', name: 'reports', methods: ['GET'])]
    public function index(): JsonResponse
    {
        return new JsonResponse([]);
    }

    /** Answers the admin's uptime monitor. */
    public function ping(): JsonResponse
    {
        return new JsonResponse(['ok' => true]);
    }
}
