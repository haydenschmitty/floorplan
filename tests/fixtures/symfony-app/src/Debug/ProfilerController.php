<?php

namespace App\Debug;

use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;

class ProfilerController
{
    #[Route('/profiler', name: 'profiler')]
    public function index(): JsonResponse
    {
        return new JsonResponse([]);
    }
}
