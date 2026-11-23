<?php

namespace App\Attribute;

/** Marks a page that appears in the site's navigation menu. Not a Symfony route. */
#[\Attribute(\Attribute::TARGET_METHOD)]
final class Route
{
    public function __construct(public string $label) {}
}
