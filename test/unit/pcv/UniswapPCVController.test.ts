import { expectRevert, balance, time, getAddresses, getCore } from '../../helpers';
import { expect } from 'chai'
import hre, { ethers, artifacts } from 'hardhat'
import { Signer } from 'ethers'

const UniswapPCVController = artifacts.readArtifactSync('UniswapPCVController');
const Fei = artifacts.readArtifactSync('Fei');
const MockOracle = artifacts.readArtifactSync('MockOracle');
const MockPair = artifacts.readArtifactSync('MockUniswapV2PairLiquidity');
const MockPCVDeposit = artifacts.readArtifactSync('MockERC20UniswapPCVDeposit');
const MockERC20 = artifacts.readArtifactSync('MockERC20');
const toBN = ethers.BigNumber.from

describe('UniswapPCVController', function () {
  const LIQUIDITY_INCREMENT = 10000; // amount of liquidity created by mock for each deposit
  let userAddress;
  let governorAddress;
  let minterAddress;
  let burnerAddress;
  let guardianAddress;

  let impersonatedSigners: { [key: string]: Signer } = { }

  before(async() => {
    const addresses = await getAddresses()

    // add any addresses you want to impersonate here
    const impersonatedAddresses = [
      addresses.userAddress,
      addresses.pcvControllerAddress,
      addresses.governorAddress,
      addresses.pcvControllerAddress,
      addresses.minterAddress,
      addresses.burnerAddress,
      addresses.beneficiaryAddress1,
      addresses.beneficiaryAddress2,
      addresses.guardianAddress
    ]

    for (const address of impersonatedAddresses) {
      await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [address]
      })

      impersonatedSigners[address] = await ethers.getSigner(address)
    }
  });

  beforeEach(async function () {
    ({
      userAddress,
      governorAddress, 
      burnerAddress,
      minterAddress, 
      guardianAddress
    } = await getAddresses());

    this.core = await getCore();

    this.fei = await ethers.getContractAt('Fei', await this.core.fei());
    this.oracle = await (await ethers.getContractFactory('MockOracle')).deploy(500);
    this.token = await (await ethers.getContractFactory('MockERC20')).deploy();
    this.pair = await (await ethers.getContractFactory('MockUniswapV2PairLiquidity')).deploy(this.token.address, this.fei.address);
    this.pcvDeposit = await (await ethers.getContractFactory('MockERC20UniswapPCVDeposit')).deploy(this.token.address);

    this.pcvController = await (await ethers.getContractFactory('UniswapPCVController')).deploy(
      this.core.address, 
      this.pcvDeposit.address, 
      this.oracle.address,
      this.oracle.address, 
      '100000000000000000000',
      '100',
      this.pair.address,
      '14400'
    );
    await this.core.connect(impersonatedSigners[governorAddress]).grantBurner(this.pcvController.address, {});
    await this.core.connect(impersonatedSigners[governorAddress]).grantBurner(this.pcvController.address, {});
    await this.core.connect(impersonatedSigners[governorAddress]).grantMinter(this.pcvController.address, {});

    await this.fei.connect(impersonatedSigners[minterAddress]).mint(this.pair.address, 50000000, {});
  });

  describe('Sole LP', function() {
    beforeEach(async function() {
      await this.token.mint(this.pcvDeposit.address, 100000);
      await this.pcvController.connect(impersonatedSigners[guardianAddress]).forceReweight({});
    });
    it('pcvDeposit gets all tokens', async function() {
      expect(await this.pcvDeposit.balance()).to.be.equal(toBN(100000));
      expect(Number(await balance.current(this.pcvController.address)).toString()).to.be.equal('0');
    });
  });

  describe('With Other LP', function() {
    describe('At peg', function() {
      beforeEach(async function() {
        await this.token.mint(this.pcvDeposit.address, 100000);
        await this.pair.connect(impersonatedSigners[userAddress]).set(100000, 50000000, LIQUIDITY_INCREMENT, { value: toBN(100000) }); // 500:1 FEI/token with 10k liquidity
      });

      it('reverts', async function() {
        await expectRevert(this.pcvController.connect(impersonatedSigners[governorAddress]).forceReweight({}), 'UniswapV2Library: INSUFFICIENT_INPUT_AMOUNT');
      });
    });

    describe('Above peg', function() {
      beforeEach(async function() {
        await this.token.mint(this.pcvDeposit.address, 100000);
        await this.token.mint(this.pair.address, 100000);
        await this.pair.connect(impersonatedSigners[userAddress]).set(100000, 49000000, LIQUIDITY_INCREMENT, { value: 100000}); // 490:1 FEI/token with 10k liquidity
        await expect(
          await this.pcvController.connect(impersonatedSigners[guardianAddress]).forceReweight())
          .to.emit(this.pcvController, 'Reweight').withArgs(guardianAddress)
      });  

      it('pair loses some tokens in swap', async function() {
        expect(await this.token.balanceOf(this.pair.address)).to.be.equal(toBN(98995));
      });

      it('pcvDeposit gets remaining tokens', async function() {
        expect(await this.pcvDeposit.balance()).to.be.equal(toBN(101005));
        expect(await this.token.balanceOf(this.pcvController.address)).to.be.equal(0);
      });
    });

    describe('Below peg', function() {
      describe('Rebases', function() {
        beforeEach(async function() {
          await this.fei.connect(impersonatedSigners[minterAddress]).mint(this.pair.address, 1000000, {}); // top up to 51m
          await this.token.mint(this.pcvDeposit.address, 100000);
          await this.pair.connect(impersonatedSigners[userAddress]).set(100000, 51000000, LIQUIDITY_INCREMENT, {value: 100000}); // 490:1 FEI/token with 10k liquidity
          await expect(
            await this.pcvController.connect(impersonatedSigners[guardianAddress]).forceReweight())
            .to.emit(this.pcvController, 'Reweight').withArgs(guardianAddress)
        });

        it('pair gets no token in swap', async function() {
          expect(await this.token.balanceOf(this.pair.address)).to.be.equal(0);
        });
        it('pcvDeposit token value remains constant', async function() {
          expect(await this.pcvDeposit.balance()).to.be.equal(toBN(100000));
        });
        it('pair FEI balance rebases', async function() {
          expect(await this.fei.balanceOf(this.pair.address)).to.be.equal(toBN(50000000));
        });
      });
    });
    
    describe('Oracle Update', function() {
      beforeEach(async function() {
        await this.token.mint(this.pcvDeposit.address, 100000);
        await this.oracle.setExchangeRate(400);
        await this.fei.connect(impersonatedSigners[minterAddress]).mint(this.pair.address, 1000000, {}); // top up to 51mthis.fei.connect(impersonatedSigners[minterAddress]).mint(this.pair.address, 1000000, {}); // top up to 51m
        await this.pair.connect(impersonatedSigners[userAddress]).set(100000, 51000000, LIQUIDITY_INCREMENT, {value: 100000}); // 490:1 FEI/token with 10k liquidity
        await expect(
          await this.pcvController.connect(impersonatedSigners[guardianAddress]).forceReweight())
          .to.emit(this.pcvController, 'Reweight').withArgs(guardianAddress)
      });

      it('pair gets no token in swap', async function() {
        expect(await this.token.balanceOf(this.pair.address)).to.be.equal(toBN(0));
      });
      it('pcvDeposit token value remains constant', async function() {
        expect(await this.pcvDeposit.balance()).to.be.equal(toBN(100000));
      });
      it('pair FEI balance rebases', async function() {
        expect(await this.fei.balanceOf(this.pair.address)).to.be.equal(toBN(40000000));
      });
    });
  });

  describe('External Reweight', function() {
    describe('Paused', function() {
      it('reverts', async function() {
        await this.pcvController.connect(impersonatedSigners[governorAddress]).pause({});
        await expectRevert(this.pcvController.reweight(), 'Pausable: paused');
      });
    });

    describe('Not yet at time', function () {
      beforeEach(async function() {
        await this.token.mint(this.pair.address, toBN(100000));
        await this.pair.connect(impersonatedSigners[userAddress]).set(100000, 51000000, LIQUIDITY_INCREMENT, { value: 100000}); // 510:1 FEI/token with 10k liquidity
      });

      it('reverts', async function() {
        expect(await this.pcvController.isTimeEnded()).to.be.equal(false);
        expect(await this.pcvController.reweightEligible()).to.be.equal(false);
        await expectRevert(this.pcvController.reweight(), 'UniswapPCVController: Not passed reweight time or not at min distance');
      });

      describe('After time period passes', function() {
        beforeEach(async function() {
          await time.increase(14400);
        });

        it('Reweight eligible', async function() {
          expect(await this.pcvController.isTimeEnded()).to.be.equal(true);
          expect(await this.pcvController.reweightEligible()).to.be.equal(true);
        });

        describe('After Reweight', function() {
          beforeEach(async function() {
            await this.token.mint(this.pcvDeposit.address, toBN(100000));
            await this.pcvController.connect(impersonatedSigners[userAddress]).reweight({});
          });
          it('timer resets', async function() {
            expect(await this.pcvController.isTimeEnded()).to.be.equal(false);
            expect(await this.pcvController.reweightEligible()).to.be.equal(false);
          });
        });
      });
    });

    describe('Not at min distance', function () {
      it('reverts', async function() {
        await this.token.mint(this.pair.address, toBN(100000));
        await this.pair.connect(impersonatedSigners[userAddress]).set(100000, 50400000, LIQUIDITY_INCREMENT, { value: 100000}); // 504:1 FEI/token with 10k liquidity
        await time.increase(14400);

        expect(await this.pcvController.reweightEligible()).to.be.equal(false);
        await expectRevert(this.pcvController.reweight(), 'UniswapPCVController: Not passed reweight time or not at min distance');
      });
    });

    describe('Above peg', function() {
      beforeEach(async function() {
        await this.fei.connect(impersonatedSigners[burnerAddress]).burnFrom(this.pair.address, 1000000, {}); // burn down to 49m
        await this.token.mint(this.pcvDeposit.address, toBN(100000));
        await this.token.mint(this.pair.address, toBN(100000));
        await this.pair.connect(impersonatedSigners[userAddress]).set(100000, 49000000, LIQUIDITY_INCREMENT, { value: 100000}); // 490:1 FEI/token with 10k liquidity
        await time.increase(14400);
        expect(await this.pcvController.reweightEligible()).to.be.equal(true);
        await this.pcvController.connect(impersonatedSigners[userAddress]).reweight({});
      });

      it('pair loses some tokens in swap', async function() {
        expect(await this.token.balanceOf(this.pair.address)).to.be.equal(toBN(98995));
      });
      it('pcvDeposit tokens value goes up', async function() {
        expect(await this.pcvDeposit.balance()).to.be.equal(toBN(101005));
      });
      it('pair FEI balance rebases', async function() {
        expect(await this.fei.balanceOf(this.pair.address)).to.be.equal(toBN(49498970));
      });
    });

    describe('No incentive for caller if controller not minter', function() {
      beforeEach(async function() {
        await this.fei.connect(impersonatedSigners[minterAddress]).mint(this.pair.address, 1000000, {}); // top up to 51m
        await this.token.mint(this.pcvDeposit.address, 100000);
        await this.pair.connect(impersonatedSigners[userAddress]).set(100000, 51000000, LIQUIDITY_INCREMENT, { value: 100000}); // 510:1 FEI/token with 10k liquidity
        await time.increase(14400);
        await this.core.connect(impersonatedSigners[governorAddress]).revokeMinter(this.pcvController.address, {});     
        expect(await this.pcvController.reweightEligible()).to.be.equal(true);
        await this.pcvController.connect(impersonatedSigners[userAddress]).reweight({});
      });

      it('pair gets no tokens in swap', async function() {
        expect(await this.token.balanceOf(this.pair.address)).to.be.equal(toBN(0));
      });
      it('pcvDeposit tokens value remains constant', async function() {
        expect(await this.pcvDeposit.balance()).to.be.equal(toBN(100000));
      });
      it('pair FEI balance rebases', async function() {
        expect(await this.fei.balanceOf(this.pair.address)).to.be.equal(toBN(50000000));
      });
    });

    describe('Incentive for caller if controller is a minter', function() {
      beforeEach(async function() {
        await this.fei.connect(impersonatedSigners[minterAddress]).mint(this.pair.address, 1000000, {}); // top up to 51m
        await this.token.mint(this.pcvDeposit.address, toBN(100000));
        await this.pair.connect(impersonatedSigners[userAddress]).set(100000, 51000000, LIQUIDITY_INCREMENT, { value: 100000}); // 490:1 FEI/token with 10k liquidity
        await time.increase(14400);
        await this.core.connect(impersonatedSigners[governorAddress]).grantMinter(this.pcvController.address, {});     
        expect(await this.pcvController.reweightEligible()).to.be.equal(true);
        await this.pcvController.connect(impersonatedSigners[userAddress]).reweight({});
      });

      it('pair gets no tokens in swap', async function() {
        expect(await this.token.balanceOf(this.pair.address)).to.be.equal(toBN(0));
      });
      it('pcvDeposit token value remains constant', async function() {
        expect(await this.pcvDeposit.balance()).to.be.equal(toBN(100000));
      });
      it('pair FEI balance rebases', async function() {
        expect(await this.fei.balanceOf(this.pair.address)).to.be.equal(toBN(50000000));
      });
    });
  });

  describe('Access', function() {
    describe('Force Reweight', function() {
      it('Non-governor call fails', async function() {
        await expectRevert(this.pcvController.connect(impersonatedSigners[userAddress]).forceReweight({}), 'CoreRef: Caller is not a guardian or governor');
      });
    });

    describe('Reweight Min Distance', function() {
      it('Governor set succeeds', async function() {
        await expect(
          await this.pcvController.connect(impersonatedSigners[governorAddress]).setReweightMinDistance(50))
          .to.emit(this.pcvController, 'ReweightMinDistanceUpdate').withArgs('100', '50')

        expect((await this.pcvController.minDistanceForReweight())[0]).to.be.equal('5000000000000000');
      });

      it('Non-governor set reverts', async function() {
        await expectRevert(this.pcvController.connect(impersonatedSigners[userAddress]).setReweightMinDistance(50, {}), 'CoreRef: Caller is not a governor');
      });
    });

    describe('Duration', function() {
      it('Governor set succeeds', async function() {
        await this.pcvController.connect(impersonatedSigners[governorAddress]).setDuration(10, {});
        expect(await this.pcvController.duration()).to.be.equal('10');
      });

      it('Non-governor set reverts', async function() {
        await expectRevert(this.pcvController.connect(impersonatedSigners[userAddress]).setDuration('10', {}), 'CoreRef: Caller is not a governor');
      });
    });

    describe('Pair', function() {
      it('Governor set succeeds', async function() {
        const pair2 = await (await ethers.getContractFactory('MockUniswapV2PairLiquidity')).deploy(this.token.address, this.fei.address);
        await this.pcvController.connect(impersonatedSigners[governorAddress]).setPair(pair2.address, {});
        expect(await this.pcvController.pair()).to.be.equal(pair2.address);
      });

      it('Non-governor set reverts', async function() {
        await expectRevert(this.pcvController.connect(impersonatedSigners[userAddress]).setPair(userAddress, {}), 'CoreRef: Caller is not a governor');
      });
    });

    describe('PCV Deposit', function() {
      it('Governor set succeeds', async function() {
        await expect(
          await this.pcvController.connect(impersonatedSigners[governorAddress]).setPCVDeposit(userAddress))
          .to.emit(this.pcvController, 'PCVDepositUpdate').withArgs(this.pcvDeposit.address, userAddress)

        expect(await this.pcvController.pcvDeposit()).to.be.equal(userAddress);
      });

      it('Non-governor set reverts', async function() {
        await expectRevert(this.pcvController.connect(impersonatedSigners[userAddress]).setPCVDeposit(userAddress, {}), 'CoreRef: Caller is not a governor');
      });
    });
    describe('Oracle', function() {
      it('Governor set succeeds', async function() {
        await this.pcvController.connect(impersonatedSigners[governorAddress]).setOracle(userAddress, {});
        expect(await this.pcvController.oracle()).to.be.equal(userAddress);
      });

      it('Non-governor set reverts', async function() {
        await expectRevert(this.pcvController.connect(impersonatedSigners[userAddress]).setOracle(userAddress, {}), 'CoreRef: Caller is not a governor');
      });
    });
  });
});
