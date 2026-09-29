import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export type AclLogAction = "add" | "remove";

/**
 * Append-only audit trail of ACL changes, one row per `ACLUpdated` event, so
 * admins can see when a contract was whitelisted and when it was removed.
 */
@Entity("contract_acl_logs")
@Index("idx_contract_acl_logs_contract_address", ["contractAddress"])
export class ContractAclLog {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "contract_address", type: "varchar", length: 56 })
  contractAddress!: string;

  @Column({ type: "varchar", length: 16 })
  action!: AclLogAction;

  @Column({ name: "permitted_functions", type: "jsonb", default: () => "'[]'::jsonb" })
  permittedFunctions!: string[];

  @Column({ name: "ledger_sequence", type: "bigint", nullable: true })
  ledgerSequence!: string | null;

  @Column({ name: "tx_hash", type: "varchar", length: 64, nullable: true })
  txHash!: string | null;

  @Column({ name: "actor", type: "varchar", length: 56, nullable: true })
  actor!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
