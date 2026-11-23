<?php

namespace App\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

class HomeController extends AbstractController
{
    #[Route('/', name: 'home')]
    public function index(): Response
    {
        return $this->render('home/index.html.twig');
    }

    /** The shop's story and the people behind it. */
    #[Route('/about', name: 'about', methods: ['GET'])]
    #[Route(path: '/team', name: 'team', methods: ['GET'])]
    public function about(): Response
    {
        return $this->render('home/about.html.twig');
    }
}
