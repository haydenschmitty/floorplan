<?php

namespace App\Controller;

use App\Attribute\Route;
use Symfony\Component\HttpFoundation\Response;

class MenuController
{
    #[Route('/menu')]
    public function menu(): Response
    {
        return new Response('');
    }
}
