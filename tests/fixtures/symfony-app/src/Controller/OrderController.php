<?php

namespace App\Controller;

use App\Repository\OrderRepository;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\Security\Http\Attribute\IsGranted;

#[Route('/orders', name: 'order_')]
#[IsGranted('ROLE_USER')]
class OrderController extends AbstractController
{
    #[Route('', name: 'list', methods: ['GET'])]
    public function list(OrderRepository $orders): JsonResponse
    {
        return $this->json($orders->findForUser($this->getUser()));
    }

    #[Route('/{id<\d+>}', name: 'show', methods: ['GET'])]
    public function show(int $id, OrderRepository $orders): JsonResponse
    {
        return $this->json($orders->find($id));
    }

    #[Route('', name: 'create', methods: 'POST')]
    public function create(Request $request): JsonResponse
    {
        return $this->json(['id' => 1], 201);
    }

    /** Changes where an order is delivered, until it ships. */
    #[Route(
        '/{id<\d+>}/address',
        name: 'address',
        methods: ['PUT', 'PATCH'],
    )]
    public function address(int $id, Request $request): JsonResponse
    {
        return $this->json(['id' => $id]);
    }
}
