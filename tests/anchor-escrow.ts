// https://zenn.dev/razokulover/articles/c2338cb83f459b

import * as anchor from "@project-serum/anchor";
import {LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction} from "@solana/web3.js";
import {ASSOCIATED_TOKEN_PROGRAM_ID, createAccount, createAssociatedTokenAccount, createMint, getAccount, mintTo, TokenAccountNotFoundError, TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {assert} from "chai";


describe("anchor-escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AnchorEscrow;

  let mintA = null;
  let mintB = null;
  let initializerTokenAccountA = null;  // takerへ送るためのアカウント
  let initializerTokenAccountB = null;  // takerからの受け取り用アカウント
  let takerTokenAccountA = null;  // initializerからの受け取り用アカウント
  let takerTokenAccountB = null;  // initializerへ送るためのアカウント

  let vault_account_pda = null;
  let vault_account_bump = null;
  let vault_authority_pda = null;

  const takerAmount = 1000;
  const initializerAmount = 500;

  // メインアカウント(taker, initializer)にSOLをAirdropするためのアカウント
  const payer = anchor.web3.Keypair.generate();
  // 主役１
  const initializerMainAccount = anchor.web3.Keypair.generate();
  // 主役2
  const takerMainAccount = anchor.web3.Keypair.generate();
  // Tokenアカウント(mintA, mintB)を作成するアカウント
  const mintAuthority = anchor.web3.Keypair.generate();
  // escrow
  const escrowAccount = anchor.web3.Keypair.generate();

  // Escrowをテストするための初期状態のセットアップ
  it("Initialize escrow state", async() => {
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL*5),
      "confirmed"
    );

    // 送受信用のlamportsをinitializerとtakerへそれぞれ送金
    await provider.sendAndConfirm(
      (() => {
        const tx = new Transaction();
        tx.add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: initializerMainAccount.publicKey,
            lamports: LAMPORTS_PER_SOL
          }),
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: takerMainAccount.publicKey,
            lamports: LAMPORTS_PER_SOL
          })  
        );
        return tx;
      })(),
      [payer]
    );

    // payerがminter(mintA, mintB)のmintに許可を与える
    mintA = await createMint(
      provider.connection,
      payer,  // アカウントの作成者
      mintAuthority.publicKey,  // 今後mintを制御するアカウント
      null,
      0,
      null,
      null,
      TOKEN_PROGRAM_ID
    );
    mintB = await createMint(
      provider.connection,
      payer,
      mintAuthority.publicKey,
      null,
      0,
      null,
      null,
      TOKEN_PROGRAM_ID
    );

    // tokenAのtokenAccountを作成．initializerにアサイン
    initializerTokenAccountA = await createAssociatedTokenAccount(provider.connection, mintA, mintA, initializerMainAccount.publicKey, null, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    // tokenBのtokenAccountを作成.initializerにアサイン
    initializerTokenAccountB = await createAssociatedTokenAccount(provider.connection, mintA, mintA, initializerMainAccount.publicKey, null, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

    // tokenAのtokenAccountを作成．takerにアサイン
    takerTokenAccountA = await createAssociatedTokenAccount(provider.connection, mintB, mintB, takerMainAccount.publicKey, null, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    // tokenBのtokenAccountを作成．takerにアサイン
    takerTokenAccountB = await createAssociatedTokenAccount(provider.connection, mintB, mintB, takerMainAccount.publicKey, null, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    
    // tokenAをinitializerにinitializerAmount枚発行
    await mintTo(provider.connection, mintA, mintA, initializerTokenAccountA, mintAuthority.publicKey, initializerAmount, [mintAuthority], null, ASSOCIATED_TOKEN_PROGRAM_ID);
    // tokenAをtakerにtakerAmount枚発行
    await mintTo(provider.connection, mintB, mintB, takerTokenAccountB, mintAuthority.publicKey, takerAmount, [mintAuthority], null, ASSOCIATED_TOKEN_PROGRAM_ID);

    // tokenが発行されているか確認
    let _initializerTokenAccountA = await getAccount(provider.connection, initializerTokenAccountA);
    let _takerTokenAccountB = await getAccount(provider.connection, takerTokenAccountB);
    assert.ok(Number(_initializerTokenAccountA.amount) == initializerAmount);
    assert.ok(Number(_takerTokenAccountB.amount) === takerAmount);

  });

  // AさんがtokenAをEscrowに送信
  it("Initialize escrow", async() => {
    // PDA keyの作成.pdaはPublicKey, bumpはnum
    const [_vault_account_pda, _vault_account_bump] = await PublicKey.findProgramAddress(
      // このseedを使ってProgram側ではkeyを復元する
      [Buffer.from(anchor.utils.bytes.utf8.encode("token-seed"))],
      program.programId
    );
    vault_account_pda = _vault_account_pda;
    vault_account_bump = _vault_account_bump;

    // PDA authorityの作成
    const [_vault_authority_pda, _vault_authority_bump] = await PublicKey.findProgramAddress(
      [Buffer.from(anchor.utils.bytes.utf8.encode("escrow"))],
      program.programId
    );
    vault_authority_pda = _vault_authority_pda;

    await program.rpc.initializeEscrow(
      vault_account_bump,
      new anchor.BN(initializerAmount),
      new anchor.BN(takerAmount),
      // #derive[Accounts]で定義したものと同じcontextを用意
      {
        accounts: {
          initializer: initializerMainAccount.publicKey,
          vaultAccount: vault_account_pda,
          mint: mintA.publicKey,
          initializerDepositTokenAccount: initializerTokenAccountA,
          initializerReceiveTokenAccount: initializerTokenAccountB,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAcount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, initializerMainAccount],
      }
    );

    let _vault = await mintA.getAccountInfo(vault_account_pda);
    let _escrowAccount = await program.account.escrowAccount.fetch(escrowAccount.publicKey);

    // Authorityがvault(PDA)にセットされているか確認
    assert.ok(_vault.owner.equals(vault_authority_pda));

    assert.ok(_escrowAccount.initializerKey.equals(initializerMainAccount.publicKey));
    assert.ok(_escrowAccount.initializerAmount.toNumber() == initializerAmount);
    assert.ok(_escrowAccount.initializerDepositTokenAccount.equals(initializerTokenAccountA));
    assert.ok(_escrowAccount.initializerReceiveTokenAccount.equals(initializerTokenAccountB));
  });

  // exchange-programによって，BさんがtokenBをAさんに送信&EscrowがBさんにtokenAを送信
  it("Exchange escrow", async() => {
    await program.rpc.exchange({
      accounts: {
        taker: takerMainAccount.publicKey,
        takerDepositTokenAccount: takerTokenAccountB,
        takerReceiveTokenAccount: takerTokenAccountA,
        initializerDepositTokenAccount: initializerTokenAccountA,
        initializerReceiveTokenAccount: initializerTokenAccountB,
        initializer: initializerMainAccount.publicKey,
        escrowAccount: escrowAccount.publicKey,
        vaultAccount: vault_account_pda,
        vaultAuthority: vault_authority_pda,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [takerMainAccount],
    });

    let _takerTokenAccountA = await getAccount(provider.connection, takerTokenAccountA);
    let _takerTokenAccountB = await getAccount(provider.connection, takerTokenAccountB);
    let _initializerTokenAccountA = await getAccount(provider.connection, initializerTokenAccountA);
    let _initializerTokenAccountB = await getAccount(provider.connection, initializerTokenAccountB);

    assert.ok(Number(_takerTokenAccountA.amount) == initializerAmount);
    assert.ok(Number(_initializerTokenAccountA.amount) == 0);
    assert.ok(Number(_initializerTokenAccountB.amount) == takerAmount);
    assert.ok(Number(_takerTokenAccountB.amount) == 0);
    
  })
});
