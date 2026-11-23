<?php

namespace App\Webhook;

use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

/** Nothing imports this folder's routes, so Symfony never serves this. */
class OrphanController
{
    #[Route('/webhooks/carrier', name: 'carrier_webhook', methods: ['POST'])]
    public function carrier(): Response
    {
        return new Response('');
    }
}
