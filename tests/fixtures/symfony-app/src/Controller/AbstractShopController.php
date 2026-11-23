<?php

namespace App\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

/** Shared helpers for the shop's pages. Symfony doesn't load routes from an abstract class. */
abstract class AbstractShopController extends AbstractController
{
    #[Route('/base', name: 'base')]
    public function base(): Response
    {
        return new Response('');
    }
}
