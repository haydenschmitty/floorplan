from flask import Blueprint
from flask_login import login_required
from checks import logged_in_required, login_required_json
from logging_helpers import log_call, logging_required, logged_request

bp = Blueprint("items", __name__)


@bp.route("/items/<int:item_id>/delete", methods=["POST"])
@login_required
def delete_item(item_id):
    return "deleted"


@bp.route("/items", methods=["GET"])
@login_required_json
def list_items():
    return []


@bp.route("/items/<int:item_id>/archive", methods=["POST"])
@logged_in_required
def archive_item(item_id):
    return "archived"


@bp.route("/actions/log-call", methods=["POST"])
@log_call
def log_call_only():
    return "saved"


@bp.route("/actions/logging", methods=["POST"])
@logging_required
def logging_only():
    return "saved"


@bp.route("/actions/logged", methods=["POST"])
@logged_request
def logged_only():
    return "saved"


@login_required
@bp.route("/actions/misplaced", methods=["POST"])
def misplaced_check():
    return "saved"
