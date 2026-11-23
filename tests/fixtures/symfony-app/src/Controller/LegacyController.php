<?php

namespace App\Controller;

use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Annotation\Route;

class LegacyController
{
    /**
     * The old cart page, kept for bookmarked links.
     *
     * @Route("/legacy/cart", name="legacy_cart", methods={"GET"})
     */
    public function cart(): Response
    {
        return new Response('', 301, ['Location' => '/']);
    }
}
