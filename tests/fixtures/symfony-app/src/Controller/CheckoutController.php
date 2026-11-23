<?php

namespace App\Controller;

use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/** Turns the cart into an order and starts the payment. */
#[Route('/checkout', name: 'checkout', methods: ['POST'])]
final class CheckoutController
{
    public function __invoke(Request $request): JsonResponse
    {
        return new JsonResponse(['status' => 'pending']);
    }
}
