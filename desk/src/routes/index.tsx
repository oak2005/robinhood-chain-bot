import { createFileRoute } from "@tanstack/react-router";
import { MemberDesk } from "@/components/desk/member-desk";

export const Route = createFileRoute("/")({ component: MemberDesk });
